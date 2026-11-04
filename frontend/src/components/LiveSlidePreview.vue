<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { Eye, ChevronLeft, ChevronRight, RefreshCw, Sparkles, Image as ImageIcon, X, Lock, Unlock } from 'lucide-vue-next'
import { buildLivePreviewSlides } from '../utils/slidePreviewRenderer'

const props = defineProps<{
  templateId: string
  templateData: Record<string, any>
  logoUrl?: string
  renderedMedia?: { type: string; url: string }[]
  activeTarget?: { type: 'top' | 'slide'; index?: number } | null
  hasUnrenderedChanges?: boolean
  rendering?: boolean
}>()

const emit = defineEmits<{
  (e: 'renderMedia'): void
  (e: 'selectSlide', index: number): void
}>()

const currentIndex = ref(0)
const previewMode = ref<'live' | 'rendered'>('live')
const autoFollowFocus = ref(true)
const isMobileModalOpen = ref(false)
const debouncedHtml = ref('')
let debounceTimer: ReturnType<typeof setTimeout> | null = null

const desktopViewportRef = ref<HTMLElement | null>(null)
const mobileViewportRef = ref<HTMLElement | null>(null)
const desktopWidth = ref(380)
const mobileWidth = ref(340)
let resizeObserver: ResizeObserver | null = null

const slides = computed(() => {
  return buildLivePreviewSlides(props.templateId || '', props.templateData, props.logoUrl || '')
})

const currentSlide = computed(() => {
  if (slides.value.length === 0) return null
  const safeIdx = Math.min(Math.max(0, currentIndex.value), slides.value.length - 1)
  return slides.value[safeIdx]
})

const currentRenderedUrl = computed(() => {
  if (!props.renderedMedia || props.renderedMedia.length === 0) return null
  return props.renderedMedia[currentIndex.value]?.url || null
})

// Keep currentIndex in bounds when slides are added/removed
watch(
  () => slides.value.length,
  (newLen) => {
    if (newLen > 0 && currentIndex.value >= newLen) {
      currentIndex.value = newLen - 1
    }
  }
)

// Auto-sync slide index when operator focuses Cover or Slide N in editor
watch(
  () => props.activeTarget,
  (target) => {
    if (!autoFollowFocus.value || !target) return
    if (target.type === 'top') {
      currentIndex.value = 0
    } else if (target.type === 'slide' && typeof target.index === 'number') {
      const targetSlideIdx = target.index + 1
      if (targetSlideIdx >= 0 && targetSlideIdx < slides.value.length) {
        currentIndex.value = targetSlideIdx
      }
    }
  },
  { deep: true }
)

// Debounce srcdoc updates slightly (100ms) for smooth typing
watch(
  () => currentSlide.value?.html,
  (newHtml) => {
    if (!newHtml) return
    if (!debouncedHtml.value) {
      debouncedHtml.value = newHtml
      return
    }
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debouncedHtml.value = newHtml
    }, 100)
  },
  { immediate: true }
)

const prevSlide = () => {
  if (currentIndex.value > 0) {
    currentIndex.value--
    emit('selectSlide', currentIndex.value)
  }
}

const nextSlide = () => {
  if (currentIndex.value < slides.value.length - 1) {
    currentIndex.value++
    emit('selectSlide', currentIndex.value)
  }
}

const goToSlide = (idx: number) => {
  if (idx >= 0 && idx < slides.value.length) {
    currentIndex.value = idx
    emit('selectSlide', idx)
  }
}

const openMobilePreview = (idx?: number) => {
  if (typeof idx === 'number' && idx >= 0 && idx < slides.value.length) {
    currentIndex.value = idx
  }
  isMobileModalOpen.value = true
  setTimeout(updateWidths, 50)
}

defineExpose({
  openMobilePreview,
  goToSlide
})

const updateWidths = () => {
  if (desktopViewportRef.value && desktopViewportRef.value.clientWidth > 50) {
    desktopWidth.value = desktopViewportRef.value.clientWidth
  }
  if (mobileViewportRef.value && mobileViewportRef.value.clientWidth > 50) {
    mobileWidth.value = mobileViewportRef.value.clientWidth
  }
}

const desktopScale = computed(() => desktopWidth.value / 1080)
const mobileScale = computed(() => mobileWidth.value / 1080)

onMounted(() => {
  updateWidths()
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => updateWidths())
    if (desktopViewportRef.value) resizeObserver.observe(desktopViewportRef.value)
  }
  window.addEventListener('resize', updateWidths)
})

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (resizeObserver) resizeObserver.disconnect()
  window.removeEventListener('resize', updateWidths)
})

watch(mobileViewportRef, (el) => {
  if (el && resizeObserver) {
    resizeObserver.observe(el)
    updateWidths()
  }
})
</script>

<template>
  <!-- 1. DESKTOP STICKY LIVE PREVIEW PANEL (lg and up) -->
  <div class="hidden lg:block sticky top-6">
    <div class="bg-default shadow-lg rounded-xl border border-default overflow-hidden">
      <!-- Top Bar -->
      <div class="px-4 py-3 border-b border-default flex items-center justify-between gap-2 bg-elevated">
        <div class="flex items-center gap-2 min-w-0">
          <Eye class="w-4 h-4 text-primary shrink-0" />
          <span class="text-sm font-bold text-default truncate">Live Preview</span>
          <span
            v-if="hasUnrenderedChanges"
            class="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-amber-500/15 text-amber-500 border border-amber-500/30 shrink-0"
            title="Text or images changed since last PNG render"
          >
            Unrendered Edits
          </span>
        </div>

        <div class="flex items-center gap-1.5 shrink-0">
          <!-- Auto-follow focus toggle -->
          <button
            type="button"
            @click="autoFollowFocus = !autoFollowFocus"
            class="p-1.5 rounded-md border text-xs transition cursor-pointer"
            :class="autoFollowFocus ? 'border-primary/40 bg-primary/10 text-primary' : 'border-default bg-default text-muted hover:text-default'"
            :title="autoFollowFocus ? 'Auto-jumping to focused slide (Click to lock)' : 'Slide locked (Click to auto-follow focus)'"
          >
            <Unlock v-if="autoFollowFocus" class="w-3.5 h-3.5" />
            <Lock v-else class="w-3.5 h-3.5" />
          </button>

          <!-- Mode Switcher: Live HTML vs Rendered PNG -->
          <div class="inline-flex rounded-lg border border-default bg-muted p-0.5 text-[11px] font-medium">
            <button
              type="button"
              @click="previewMode = 'live'"
              class="px-2 py-1 rounded-md flex items-center gap-1 transition cursor-pointer"
              :class="previewMode === 'live' ? 'bg-default text-default shadow-xs' : 'text-muted hover:text-default'"
            >
              <Sparkles class="w-3 h-3 text-amber-500" />
              Live
            </button>
            <button
              type="button"
              @click="previewMode = 'rendered'"
              class="px-2 py-1 rounded-md flex items-center gap-1 transition cursor-pointer"
              :class="previewMode === 'rendered' ? 'bg-default text-default shadow-xs' : 'text-muted hover:text-default'"
            >
              <ImageIcon class="w-3 h-3 text-emerald-500" />
              PNG
            </button>
          </div>
        </div>
      </div>

      <!-- 4:5 Slide Canvas Viewport -->
      <div class="p-4 bg-muted/50">
        <div
          ref="desktopViewportRef"
          class="relative w-full aspect-[4/5] rounded-lg overflow-hidden bg-black shadow-md border border-default select-none"
        >
          <!-- Live HTML Iframe -->
          <template v-if="previewMode === 'live'">
            <iframe
              v-if="debouncedHtml"
              :srcdoc="debouncedHtml"
              sandbox="allow-scripts"
              class="pointer-events-none border-0 origin-top-left"
              :style="{
                width: '1080px',
                height: '1350px',
                transform: `scale(${desktopScale})`
              }"
            ></iframe>
          </template>

          <!-- Rendered S3 PNG -->
          <template v-else>
            <img
              v-if="currentRenderedUrl"
              :src="currentRenderedUrl"
              class="w-full h-full object-contain bg-black"
              alt="Rendered Slide PNG"
            />
            <div v-else class="w-full h-full flex flex-col items-center justify-center text-center p-6 text-muted">
              <ImageIcon class="w-8 h-8 mb-2 opacity-50" />
              <p class="text-xs font-medium">No rendered PNG for this slide yet.</p>
              <button
                type="button"
                @click="emit('renderMedia')"
                :disabled="rendering"
                class="mt-3 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-inverted hover:bg-primary/90 disabled:opacity-50 cursor-pointer"
              >
                {{ rendering ? 'Rendering...' : 'Render PNGs Now' }}
              </button>
            </div>
          </template>

          <!-- Floating Slide Badge + Prev/Next Arrows -->
          <div class="absolute top-2.5 right-2.5 z-10 px-2.5 py-1 rounded-full bg-black/75 backdrop-blur-xs text-white text-[11px] font-semibold border border-white/15">
            {{ currentSlide?.label || 'Slide' }} ({{ currentIndex + 1 }}/{{ slides.length }})
          </div>

          <button
            v-if="currentIndex > 0"
            type="button"
            @click="prevSlide"
            class="absolute left-2 top-1/2 -translate-y-1/2 z-10 p-1.5 rounded-full bg-black/70 text-white hover:bg-black/90 border border-white/15 transition cursor-pointer"
            title="Previous Slide"
          >
            <ChevronLeft class="w-4 h-4" />
          </button>
          <button
            v-if="currentIndex < slides.length - 1"
            type="button"
            @click="nextSlide"
            class="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-1.5 rounded-full bg-black/70 text-white hover:bg-black/90 border border-white/15 transition cursor-pointer"
            title="Next Slide"
          >
            <ChevronRight class="w-4 h-4" />
          </button>
        </div>

        <!-- Slide Pills Strip -->
        <div class="mt-3 flex items-center gap-1.5 overflow-x-auto pb-1">
          <button
            v-for="(s, idx) in slides"
            :key="s.key"
            type="button"
            @click="goToSlide(idx)"
            class="px-2.5 py-1 rounded-md text-xs font-medium shrink-0 transition cursor-pointer border"
            :class="
              currentIndex === idx
                ? 'bg-primary text-inverted border-primary shadow-xs'
                : 'bg-default text-muted border-default hover:text-default'
            "
          >
            {{ idx === 0 ? 'Cover' : idx }}
          </button>
        </div>
      </div>

      <!-- Footer Action: Save & Render PNGs -->
      <div class="px-4 py-3 border-t border-default bg-default flex items-center justify-between gap-2">
        <span class="text-xs text-muted truncate">
          {{ currentSlide?.sublabel || 'Instant 1080x1350 preview' }}
        </span>
        <button
          type="button"
          @click="emit('renderMedia')"
          :disabled="rendering"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition cursor-pointer shrink-0"
          :class="
            hasUnrenderedChanges
              ? 'bg-amber-500 text-black hover:bg-amber-400 shadow-xs'
              : 'bg-elevated text-default border border-default hover:bg-muted'
          "
        >
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': rendering }" />
          {{ rendering ? 'Rendering PNGs...' : (hasUnrenderedChanges ? 'Save & Render PNGs' : 'Re-render PNGs') }}
        </button>
      </div>
    </div>
  </div>

  <!-- 2. MOBILE FLOATING PREVIEW BUTTON (< 1024px) -->
  <div class="lg:hidden fixed bottom-24 right-4 z-40">
    <button
      type="button"
      @click="openMobilePreview()"
      class="inline-flex items-center gap-2 px-4 py-2.5 rounded-full shadow-xl font-semibold text-xs bg-primary text-inverted border border-white/20 cursor-pointer active:scale-95 transition"
    >
      <Eye class="w-4 h-4" />
      <span>Preview ({{ currentIndex === 0 ? 'Cover' : `Slide ${currentIndex}` }})</span>
      <span
        v-if="hasUnrenderedChanges"
        class="w-2 h-2 rounded-full bg-amber-400 animate-ping"
      ></span>
    </button>
  </div>

  <!-- 3. MOBILE PREVIEW MODAL (< 1024px) -->
  <Teleport to="body">
    <div
      v-if="isMobileModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-3 sm:p-6"
      @click.self="isMobileModalOpen = false"
    >
      <div class="bg-default border border-default rounded-2xl w-full max-w-md overflow-hidden shadow-2xl flex flex-col max-h-[92vh]">
        <!-- Modal Header -->
        <div class="px-4 py-3 border-b border-default flex items-center justify-between bg-elevated">
          <div class="flex items-center gap-2">
            <Eye class="w-4 h-4 text-primary" />
            <span class="text-sm font-bold text-default">
              {{ currentSlide?.label }} ({{ currentIndex + 1 }}/{{ slides.length }})
            </span>
          </div>

          <div class="flex items-center gap-2">
            <div class="inline-flex rounded-lg border border-default bg-muted p-0.5 text-[11px] font-medium">
              <button
                type="button"
                @click="previewMode = 'live'"
                class="px-2 py-1 rounded-md transition"
                :class="previewMode === 'live' ? 'bg-default text-default shadow-xs' : 'text-muted'"
              >
                Live
              </button>
              <button
                type="button"
                @click="previewMode = 'rendered'"
                class="px-2 py-1 rounded-md transition"
                :class="previewMode === 'rendered' ? 'bg-default text-default shadow-xs' : 'text-muted'"
              >
                PNG
              </button>
            </div>
            <button
              type="button"
              @click="isMobileModalOpen = false"
              class="p-1.5 rounded-full text-muted hover:text-default hover:bg-muted"
            >
              <X class="w-5 h-5" />
            </button>
          </div>
        </div>

        <!-- Modal Body: Scaled 4:5 Canvas -->
        <div class="p-3 bg-muted/40 flex-1 overflow-y-auto flex flex-col items-center justify-center">
          <div
            ref="mobileViewportRef"
            class="relative w-full aspect-[4/5] rounded-lg overflow-hidden bg-black shadow-md border border-default"
          >
            <template v-if="previewMode === 'live'">
              <iframe
                v-if="debouncedHtml"
                :srcdoc="debouncedHtml"
                sandbox="allow-scripts"
                class="pointer-events-none border-0 origin-top-left"
                :style="{
                  width: '1080px',
                  height: '1350px',
                  transform: `scale(${mobileScale})`
                }"
              ></iframe>
            </template>
            <template v-else>
              <img
                v-if="currentRenderedUrl"
                :src="currentRenderedUrl"
                class="w-full h-full object-contain bg-black"
                alt="Rendered Slide PNG"
              />
              <div v-else class="w-full h-full flex flex-col items-center justify-center text-center p-6 text-muted">
                <p class="text-xs">No rendered PNG yet.</p>
              </div>
            </template>

            <button
              v-if="currentIndex > 0"
              type="button"
              @click="prevSlide"
              class="absolute left-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/75 text-white border border-white/15"
            >
              <ChevronLeft class="w-5 h-5" />
            </button>
            <button
              v-if="currentIndex < slides.length - 1"
              type="button"
              @click="nextSlide"
              class="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/75 text-white border border-white/15"
            >
              <ChevronRight class="w-5 h-5" />
            </button>
          </div>

          <!-- Slide Pills -->
          <div class="mt-3 w-full flex items-center gap-1.5 overflow-x-auto pb-1">
            <button
              v-for="(s, idx) in slides"
              :key="s.key"
              type="button"
              @click="goToSlide(idx)"
              class="px-3 py-1 rounded-md text-xs font-medium shrink-0 border"
              :class="
                currentIndex === idx
                  ? 'bg-primary text-inverted border-primary'
                  : 'bg-default text-muted border-default'
              "
            >
              {{ idx === 0 ? 'Cover' : `Slide ${idx}` }}
            </button>
          </div>
        </div>

        <!-- Modal Footer -->
        <div class="px-4 py-3 border-t border-default bg-default flex items-center justify-between gap-2">
          <button
            type="button"
            @click="emit('renderMedia')"
            :disabled="rendering"
            class="flex-1 inline-flex justify-center items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-primary text-inverted hover:bg-primary/90 disabled:opacity-50"
          >
            <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': rendering }" />
            {{ rendering ? 'Rendering PNGs...' : 'Save & Render PNGs' }}
          </button>
          <button
            type="button"
            @click="isMobileModalOpen = false"
            class="px-4 py-2 text-xs font-medium rounded-md border border-default bg-default text-default"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
