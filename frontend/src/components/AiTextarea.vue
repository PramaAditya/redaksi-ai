<script setup lang="ts">
import { ref, watch } from 'vue'
import { Sparkles, Undo2, RefreshCw, Shield, ShieldCheck } from 'lucide-vue-next'
import { getAuthHeaders } from '../auth'
import { censorTextWithReport, type BannedWord } from '../sanitize'
import { useConnectionStore } from '../store'

const props = defineProps<{
  modelValue: string
  placeholder?: string
  rows?: number
  guidancePlaceholder?: string
  guidanceDescription?: string
  aiContext?: string
  bannedWords?: BannedWord[]
  connectionId?: number
}>()

const emit = defineEmits(['update:modelValue', 'pasteImage', 'focus', 'blur'])

const onPaste = (e: ClipboardEvent) => {
  const items = e.clipboardData?.items
  if (items) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile()
        if (file) {
          e.preventDefault()
          e.stopPropagation()
          emit('pasteImage', file)
          return
        }
      }
    }
  }
}

const text = ref(props.modelValue)
watch(() => props.modelValue, (val) => { text.value = val })

const isPopoverOpen = ref(false)
const instruction = ref('')
const isRefining = ref(false)
const previousText = ref('')
const canUndo = ref(false)
const isCensoring = ref(false)
const justCensored = ref(false)
const lastAction = ref<'ai' | 'censor' | null>(null)
const connectionStore = useConnectionStore()
const toast = useToast()
const onInput = (e: Event) => {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
  canUndo.value = false
  lastAction.value = null
}

const refine = async () => {
  const textToRefine = text.value || previousText.value;
  if (!textToRefine) return;

  isRefining.value = true
  try {
    const res = await fetch('/api/ai/refine-text', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        text: textToRefine,
        instruction: instruction.value,
        context: props.aiContext
      })
    })
    if (!res.ok) throw new Error('Failed to refine')
    const data = await res.json()
    
    // Save previous text for undo
    if (!canUndo.value) {
      previousText.value = text.value
    }
    
    text.value = data.refinedText
    emit('update:modelValue', text.value)
    canUndo.value = true
    lastAction.value = 'ai'
    isPopoverOpen.value = false
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    alert(message)
  } finally {
    isRefining.value = false
  }
}

const undo = () => {
  text.value = previousText.value
  emit('update:modelValue', text.value)
  canUndo.value = false
  lastAction.value = null
}

const applyCensor = async () => {
  const currentVal = text.value || ''
  if (!currentVal) return

  isCensoring.value = true
  try {
    let words = props.bannedWords
    if (!words || words.length === 0) {
      await connectionStore.ensureConnectionsLoaded()
      words = connectionStore.getBannedWords(props.connectionId)
    }

    if (!words || words.length === 0) {
      toast.add({
        title: 'Banned Words Kosong',
        description: 'Belum ada list kata terlarang di pengaturan koneksi.',
        color: 'warning'
      })
      return
    }

    const { censoredText, replacedCount, replacedWords } = censorTextWithReport(currentVal, words)

    if (replacedCount === 0) {
      toast.add({
        title: 'Teks Aman',
        description: 'Tidak ada kata terlarang yang ditemukan.',
        color: 'success'
      })
      return
    }

    previousText.value = currentVal
    canUndo.value = true
    lastAction.value = 'censor'

    text.value = censoredText
    emit('update:modelValue', censoredText)

    justCensored.value = true
    setTimeout(() => {
      justCensored.value = false
    }, 2000)

    toast.add({
      title: 'Kata Terlarang Diganti',
      description: `${replacedCount} kata disensor: ${replacedWords.join(', ')}`,
      color: 'success'
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    toast.add({
      title: 'Gagal Menyensor',
      description: message,
      color: 'error'
    })
  } finally {
    isCensoring.value = false
  }
}
</script>

<template>
  <div class="relative">
    <textarea
      v-model="text"
      @input="onInput"
      @paste="onPaste"
      @focus="emit('focus')"
      @blur="emit('blur')"
      :rows="rows || 6"
      :placeholder="placeholder"
      class="w-full px-4 py-3 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-sm bg-default text-default placeholder-muted pr-12"
    ></textarea>
    
    <div class="absolute top-2 right-2 flex flex-col gap-1 z-10">
      <UPopover v-model:open="isPopoverOpen" :content="{ side: 'bottom', align: 'end' }">
        <button 
          type="button"
          class="p-1.5 text-muted hover:text-primary hover:bg-primary-50 rounded-md transition-colors cursor-pointer"
          title="Enhance with AI"
        >
          <Sparkles class="w-4 h-4" />
        </button>

        <template #content>
          <div class="p-4 w-72 bg-default border border-default rounded-md shadow-lg">
            <label class="block text-sm font-semibold text-default mb-2">Enhance Guidance (Optional)</label>
            <input 
              v-model="instruction"
              type="text"
              @keyup.enter="refine"
              :placeholder="guidancePlaceholder || 'e.g., make it more professional'"
              class="w-full px-3 py-2 border border-default rounded-md text-sm bg-muted text-default mb-2 focus:ring-1 focus:ring-primary focus:outline-none"
            />
            <p class="text-xs text-muted mb-4">
              {{ guidanceDescription || 'Add specific instructions to guide how the AI enhances your text.' }}
            </p>
            <div class="flex justify-end gap-2">
              <UButton color="gray" variant="ghost" size="sm" @click="isPopoverOpen = false">Cancel</UButton>
              <UButton color="primary" variant="solid" size="sm" @click="refine" :loading="isRefining">
                Enhance
              </UButton>
            </div>
          </div>
        </template>
      </UPopover>
      <button 
        type="button"
        @click="applyCensor"
        :disabled="isCensoring"
        class="p-1.5 rounded-md transition-colors cursor-pointer"
        :class="justCensored ? 'text-emerald-500 bg-emerald-50 dark:bg-emerald-950/40' : 'text-muted hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-950/40'"
        title="Search & Replace Banned Words (Censor)"
      >
        <ShieldCheck v-if="justCensored" class="w-4 h-4 text-emerald-500" />
        <Shield v-else class="w-4 h-4" />
      </button>


      <button 
        v-if="canUndo"
        type="button"
        @click="undo"
        class="p-1.5 text-warning hover:text-warning-600 hover:bg-warning-50 rounded-md transition-colors cursor-pointer"
        :title="lastAction === 'censor' ? 'Undo Censor' : 'Undo Enhancement'"
      >
        <Undo2 class="w-4 h-4" />
      </button>

      <button 
        v-if="canUndo && lastAction === 'ai'"
        type="button"
        @click="refine"
        class="p-1.5 text-primary hover:text-primary-700 hover:bg-primary-50 rounded-md transition-colors cursor-pointer"
        title="Retry Enhancement"
        :disabled="isRefining"
      >
        <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': isRefining }" />
      </button>
    </div>
  </div>
</template>