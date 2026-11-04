<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { PenTool, Loader2, RefreshCw, Sparkles, Zap } from 'lucide-vue-next'
import { getAuthHeaders } from '../auth'
import ImageUploader from '../components/ImageUploader.vue'
import { useConnectionStore } from '../store'

const toast = useToast()
const router = useRouter()
const connectionStore = useConnectionStore()

const tabItems = [
  { label: 'AI Generated', slot: 'ai', icon: 'i-lucide-sparkles' },
  { label: 'Script to Carousel', slot: 'script', icon: 'i-lucide-layers' },
  { label: 'Manual Queue', slot: 'manual', icon: 'i-lucide-pen-tool' },
  { label: 'Batch Reels', slot: 'batch', icon: 'i-lucide-file-spreadsheet' }
]
const activeTab = ref('ai')

const textInput = ref('')
const mediaUrls = ref<string[]>([])
const templateId = ref('image:poros.perjuangan:carousel_multi_images')
const submitting = ref(false)
const error = ref('')
const activeJobs = ref<any[]>([])
const uploaderRef = ref<InstanceType<typeof ImageUploader> | null>(null)
let intervalId: any = null;

// Script to Carousel State
const scriptText = ref('')
const scriptTemplateId = ref('image:aa.geopolitik:carousel_analysis')
const scriptSubmitting = ref(false)
const scriptSubmittingMode = ref<'draft' | 'worker' | null>(null)
const scriptError = ref('')

const detectedSlideCount = computed(() => {
  const raw = scriptText.value.trim()
  if (!raw) return 0
  const slideMatches = raw.match(/\bslide\s*\d+\b/gi)
  if (slideMatches && slideMatches.length >= 2) return slideMatches.length
  const headlineMatches = raw.match(/\b(headline|judul)\s*:/gi)
  if (headlineMatches && headlineMatches.length >= 2) return headlineMatches.length
  return 0
})

// Manual Form State
const manualType = ref('post')
const manualText = ref('')
const manualMediaUrls = ref<string[]>([])
const manualSubmitting = ref(false)
const manualError = ref('')
const manualUploaderRef = ref<InstanceType<typeof ImageUploader> | null>(null)

// Batch Reels State
const batchFile = ref<File | null>(null)
const batchSubmitting = ref(false)
const batchError = ref('')
const batchFileInput = ref<HTMLInputElement | null>(null)
const availableTemplates = ref<any[]>([])

const fetchTemplates = async () => {
  try {
    const res = await fetch('/api/templates', { headers: getAuthHeaders() })
    if (res.ok) {
      availableTemplates.value = await res.json()
      if (availableTemplates.value.length > 0) {
        templateId.value = availableTemplates.value[0].id
      }
    }
  } catch (e) {}
}

function parseCSV(str: string): string[][] {
  const result: string[][] = []
  let row: string[] = []
  let inQuotes = false
  let val = ''
  for (let i = 0; i < str.length; i++) {
    const char = str[i]
    const nextChar = str[i + 1]
    if (char === '"' && inQuotes && nextChar === '"') {
      val += '"'
      i++
    } else if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      row.push(val)
      val = ''
    } else if ((char === '\n' || (char === '\r' && nextChar === '\n')) && !inQuotes) {
      if (char === '\r') i++
      row.push(val)
      result.push(row)
      row = []
      val = ''
    } else {
      val += char
    }
  }
  row.push(val)
  if (row.length > 0 && row.some(c => c.trim())) {
    result.push(row)
  }
  return result
}

const handleBatchFileSelect = (e: Event) => {
  const target = e.target as HTMLInputElement
  if (target.files && target.files.length > 0) {
    batchFile.value = target.files[0]
  }
}

const submitBatch = async () => {
  if (!batchFile.value) {
    batchError.value = 'Please select a CSV file.'
    return
  }
  if (!connectionStore.activeConnectionId) {
    batchError.value = 'Please select a connection first.'
    return
  }

  batchError.value = ''
  batchSubmitting.value = true

  try {
    const text = await batchFile.value.text()
    const rows = parseCSV(text)
    
    // Assumes header: video_url,caption
    if (rows.length < 2) {
      throw new Error('CSV must contain a header and at least one row of data.')
    }

    const items = []
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      if (row.length < 2) continue
      
      const videoUrl = row[0].trim()
      const caption = row.slice(1).join(',').trim() // In case caption is unquoted and has commas, though our parser handles quoted commas correctly

      if (!videoUrl || !caption) continue

      items.push({
        text: caption,
        media: [{ type: 'video', url: videoUrl }],
        type: 'reel'
      })
    }

    if (items.length === 0) {
      throw new Error('No valid items found in the CSV.')
    }

    const res = await fetch('/api/queue/batch', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        connectionId: connectionStore.activeConnectionId,
        items
      })
    })

    if (res.status === 401) {
      toast.add({ title: 'Unauthorized', color: 'error' })
      return
    }

    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to add batch to queue')

    toast.add({ title: 'Batch Added to Queue!', description: `Successfully queued ${items.length} reels.`, color: 'success' })
    
    // Reset form
    batchFile.value = null
    if (batchFileInput.value) batchFileInput.value.value = ''
  } catch (err: any) {
    batchError.value = err.message
  } finally {
    batchSubmitting.value = false
  }
}

const handlePaste = (e: ClipboardEvent) => {
  const items = e.clipboardData?.items
  if (!items) return

  for (const item of items) {
    if (item.type.startsWith('image/') || item.type.startsWith('video/')) {
      const file = item.getAsFile()
      if (file) {
        if (activeTab.value === 'ai' && uploaderRef.value) {
          uploaderRef.value.uploadFile(file)
        } else if (activeTab.value === 'manual' && manualUploaderRef.value) {
          manualUploaderRef.value.uploadFile(file)
        }
      }
    }
  }
}

const fetchActiveJobs = async () => {
  if (!connectionStore.activeConnectionId) {
    activeJobs.value = []
    return
  }

  try {
    const res = await fetch(`/api/jobs/dashboard?connectionId=${connectionStore.activeConnectionId}`, { headers: getAuthHeaders() })
    if (res.ok) {
      activeJobs.value = await res.json()
    }
  } catch (e) {}
}

watch(() => connectionStore.activeConnectionId, () => {
  fetchActiveJobs();
}, { immediate: true });

onMounted(() => {
  fetchTemplates()
  intervalId = setInterval(fetchActiveJobs, 5000)
  window.addEventListener('paste', handlePaste)
})

onUnmounted(() => {
  clearInterval(intervalId)
  window.removeEventListener('paste', handlePaste)
})

const generateContent = async () => {
  if (!textInput.value.trim()) {
    toast.add({ title: 'Topic or text input is required.', color: 'error' })
    return
  }
  if (!connectionStore.activeConnectionId) {
    toast.add({ title: 'Please select a connection first.', color: 'error' })
    return
  }
  
  submitting.value = true
  error.value = ''
  
  try {
    const res = await fetch('/api/generate-content', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        connectionId: connectionStore.activeConnectionId,
        text: textInput.value,
        mediaUrls: mediaUrls.value,
        templateId: templateId.value
      })
    })
    
    if (res.status === 401) {
      toast.add({ title: 'Unauthorized', color: 'error' })
      return
    }
    
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to trigger generation')
    
    toast.add({ title: 'Generation triggered!', description: 'The worker is processing it.', color: 'success' })
    textInput.value = ''
    mediaUrls.value = []
    fetchActiveJobs()
  } catch (err: any) {
    error.value = err.message
  } finally {
    submitting.value = false
  }
}

const submitScriptDraft = async () => {
  if (!scriptText.value.trim()) {
    scriptError.value = 'Please paste your slide script first.'
    return
  }
  if (!connectionStore.activeConnectionId) {
    scriptError.value = 'Please select a connection first.'
    return
  }

  scriptSubmitting.value = true
  scriptSubmittingMode.value = 'draft'
  scriptError.value = ''

  try {
    const res = await fetch('/api/queue/from-script', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: connectionStore.activeConnectionId,
        text: scriptText.value,
        templateId: scriptTemplateId.value,
        generateImages: false,
        status: 'draft'
      })
    })
    if (res.status === 401) {
      toast.add({ title: 'Unauthorized', color: 'error' })
      return
    }
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to parse script')

    toast.add({
      title: 'Script Parsed!',
      description: `Created Cover + ${data.slideCount} slides with AI image prompts.`,
      color: 'success'
    })
    scriptText.value = ''
    router.push(`/post/${data.item.id}`)
  } catch (err: unknown) {
    scriptError.value = err instanceof Error ? err.message : String(err)
  } finally {
    scriptSubmitting.value = false
    scriptSubmittingMode.value = null
  }
}

const submitScriptFullWorker = async () => {
  if (!scriptText.value.trim()) {
    scriptError.value = 'Please paste your slide script first.'
    return
  }
  if (!connectionStore.activeConnectionId) {
    scriptError.value = 'Please select a connection first.'
    return
  }

  scriptSubmitting.value = true
  scriptSubmittingMode.value = 'worker'
  scriptError.value = ''

  try {
    const res = await fetch('/api/generate-content', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: connectionStore.activeConnectionId,
        text: scriptText.value,
        mediaUrls: [],
        templateId: scriptTemplateId.value
      })
    })
    if (res.status === 401) {
      toast.add({ title: 'Unauthorized', color: 'error' })
      return
    }
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to enqueue script job')

    toast.add({
      title: 'Full Carousel Job Enqueued!',
      description: 'Worker is generating AI images and rendering your slides (research skipped).',
      color: 'success'
    })
    scriptText.value = ''
    activeTab.value = 'ai'
    fetchActiveJobs()
  } catch (err: unknown) {
    scriptError.value = err instanceof Error ? err.message : String(err)
  } finally {
    scriptSubmitting.value = false
    scriptSubmittingMode.value = null
  }
}

const isVideo = (url: string) => {
  return url.match(/\.(mp4|mov|webm)$/i) !== null
}

const submitManual = async () => {
  const urls = Array.isArray(manualMediaUrls.value) ? manualMediaUrls.value : (manualMediaUrls.value ? [manualMediaUrls.value] : [])

  if (!manualText.value.trim()) {
    manualError.value = 'Caption text is required.'
    return
  }
  if (urls.length === 0) {
    manualError.value = 'At least one media file is required.'
    return
  }
  if (!connectionStore.activeConnectionId) {
    manualError.value = 'Please select a connection first.'
    return
  }
  
  manualError.value = ''

  if (manualType.value === 'reel') {
    if (urls.length > 1) {
      manualError.value = 'Reels can only have one video.'
      return
    }
    if (!isVideo(urls[0])) {
      manualError.value = 'Reels must be a video file.'
      return
    }
  } else if (manualType.value === 'post') {
    for (const url of urls) {
      if (isVideo(url)) {
        manualError.value = 'Posts must be image only. No video files allowed.'
        return
      }
    }
  }

  manualSubmitting.value = true
  
  try {
    const formattedMedia = urls.map(url => ({
      url,
      type: isVideo(url) ? 'video' : 'image'
    }))

    const res = await fetch('/api/queue', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        connectionId: connectionStore.activeConnectionId,
        text: manualText.value,
        media: formattedMedia,
        type: manualType.value
      })
    })
    
    if (res.status === 401) {
      toast.add({ title: 'Unauthorized', color: 'error' })
      return
    }
    
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to add to queue')
    
    toast.add({ title: 'Added to Queue!', description: 'Your post has been successfully queued.', color: 'success' })
    manualText.value = ''
    manualMediaUrls.value = []
  } catch (err: any) {
    manualError.value = err.message
  } finally {
    manualSubmitting.value = false
  }
}
</script>

<template>
  <div class="max-w-3xl mx-auto space-y-6">
    <div class="bg-default shadow rounded-lg p-6">
      <h1 class="text-2xl font-bold text-default mb-6 flex items-center">
        <PenTool class="w-6 h-6 mr-3 text-primary" />
        Create Content
      </h1>
      
      <div v-if="!connectionStore.activeConnectionId" class="text-center py-10 bg-default border border-default rounded-lg text-muted mb-6">
         Please select or create a connection from the sidebar.
      </div>

      <div v-else>
        <UTabs :items="tabItems" class="w-full" @change="(index: number) => { if (typeof index === 'number') activeTab = tabItems[index].slot }">
          <!-- AI Generated Tab -->
          <template #ai>
            <div class="mt-6 space-y-6">
              <p class="text-sm text-muted mb-6">
                Enter a topic, URL, or raw text below. Our AI worker will automatically research, write the caption, and render the Instagram carousel images just like it does via Telegram.
              </p>

              <div>
                <label class="block text-sm font-medium text-default mb-2">Template</label>
                <select 
                  v-model="templateId"
                  class="w-full px-4 py-3 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-base bg-default text-default"
                >
                  <option v-for="t in availableTemplates" :key="t.id" :value="t.id">
                    {{ t.name }}
                  </option>
                </select>
              </div>

              <div>
                <label class="block text-sm font-medium text-default mb-2">Topic or Reference URL *</label>
                <textarea 
                  v-model="textInput" 
                  rows="4" 
                  placeholder="e.g. Breaking: Israel strikes Iran facility, or paste a news URL"
                  class="w-full px-4 py-3 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-base bg-default text-default placeholder-muted"
                ></textarea>
              </div>

              <div>
                <label class="block text-sm font-medium text-default mb-2">Optional Reference Media</label>
                <p class="text-xs text-muted mb-2">Upload images or videos to be used as a reference or as the actual media. You can also paste media directly anywhere on this page.</p>
                <ImageUploader ref="uploaderRef" v-model="mediaUrls" :multiple="true" />
              </div>

              <UAlert v-if="error" color="error" variant="soft" :description="error" />

              <button 
                @click="generateContent" 
                :disabled="submitting || !textInput.trim()"
                class="w-full flex justify-center items-center px-4 py-3 border border-transparent shadow-sm text-base font-medium rounded-md text-inverted bg-primary hover:bg-primary focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50"
              >
                <Loader2 v-if="submitting" class="w-5 h-5 mr-2 animate-spin" />
                {{ submitting ? 'Submitting to Worker...' : 'Generate Carousel' }}
              </button>
            </div>
          </template>

          <!-- Script to Carousel Tab -->
          <template #script>
            <div class="mt-6 space-y-6">
              <div class="p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm text-default space-y-1">
                <p class="font-semibold text-amber-500">✨ Verbatim Script-to-Carousel Mode (Dynamic Slide Count)</p>
                <p class="text-xs text-muted">
                  Paste a structured draft (<code>Slide 1 ... Slide N</code>). <strong>Slide 1</strong> becomes the <strong>Cover (Title + Subtitle)</strong>, and <strong>Slides 2..N</strong> become body slides (supports any number of slides) with minimal text alteration and automatic AI background image prompts.
                </p>
              </div>

              <div>
                <label class="block text-sm font-medium text-default mb-2">Template</label>
                <select 
                  v-model="scriptTemplateId"
                  class="w-full px-4 py-3 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-base bg-default text-default"
                >
                  <option v-for="t in availableTemplates" :key="t.id" :value="t.id">
                    {{ t.name }}
                  </option>
                </select>
              </div>

              <div>
                <div class="flex items-center justify-between mb-2">
                  <label class="block text-sm font-medium text-default">Slide Script (Slide 1 = Cover, Slide 2..N = Body Slides) *</label>
                  <span v-if="detectedSlideCount >= 2" class="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/30">
                    Detected {{ detectedSlideCount }} Slides (1 Cover + {{ detectedSlideCount - 1 }} Body Slides)
                  </span>
                </div>
                <textarea 
                  v-model="scriptText" 
                  rows="12" 
                  placeholder="Slide 1&#10;Headline: Pemilu AS Baru Saja Selesai. Kenapa Kita di Indonesia Harus Peduli?&#10;Teks: Pemilu paruh waktu (Midterm Elections) di Amerika Serikat baru saja usai...&#10;&#10;Slide 2&#10;Headline: Midterm Election Itu Apa Sih?&#10;Teks: Midterm bukan ajang memilih Presiden, melainkan pemilihan anggota Kongres..."
                  class="w-full px-4 py-3 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-sm font-mono bg-default text-default placeholder-muted"
                ></textarea>
              </div>

              <UAlert v-if="scriptError" color="error" variant="soft" :description="scriptError" />

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button 
                  type="button"
                  @click="submitScriptDraft" 
                  :disabled="scriptSubmitting || !scriptText.trim()"
                  class="w-full flex justify-center items-center px-4 py-3 border border-default shadow-sm text-sm font-medium rounded-md text-default bg-default hover:bg-muted disabled:opacity-50 cursor-pointer transition"
                >
                  <Loader2 v-if="scriptSubmitting && scriptSubmittingMode === 'draft'" class="w-4 h-4 mr-2 animate-spin" />
                  <Sparkles v-else class="w-4 h-4 mr-2 text-amber-500" />
                  {{ scriptSubmitting && scriptSubmittingMode === 'draft' ? 'Parsing Script & Prompts...' : 'Fast Draft (Parse & Review Prompts ~5s)' }}
                </button>

                <button 
                  type="button"
                  @click="submitScriptFullWorker" 
                  :disabled="scriptSubmitting || !scriptText.trim()"
                  class="w-full flex justify-center items-center px-4 py-3 border border-transparent shadow-sm text-sm font-medium rounded-md text-inverted bg-primary hover:bg-primary disabled:opacity-50 cursor-pointer transition"
                >
                  <Loader2 v-if="scriptSubmitting && scriptSubmittingMode === 'worker'" class="w-4 h-4 mr-2 animate-spin" />
                  <Zap v-else class="w-4 h-4 mr-2" />
                  {{ scriptSubmitting && scriptSubmittingMode === 'worker' ? 'Enqueuing Worker...' : 'Full Auto (Generate Images & Render)' }}
                </button>
              </div>
            </div>
          </template>

          <!-- Manual Queue Tab -->
          <template #manual>
            <div class="mt-6 space-y-6">
              <p class="text-sm text-muted mb-6">
                Directly add a post or reel to your pending queue without AI generation.
              </p>
              
              <div>
                <label class="block text-sm font-medium text-default mb-2">Post Type</label>
                <div class="flex items-center space-x-4">
                  <label class="inline-flex items-center">
                    <input type="radio" v-model="manualType" value="post" class="form-radio text-primary border-default bg-default" />
                    <span class="ml-2 text-default">Post (Images only)</span>
                  </label>
                  <label class="inline-flex items-center">
                    <input type="radio" v-model="manualType" value="reel" class="form-radio text-primary border-default bg-default" />
                    <span class="ml-2 text-default">Reel (Single video)</span>
                  </label>
                </div>
              </div>

              <div>
                <label class="block text-sm font-medium text-default mb-2">Caption *</label>
                <textarea 
                  v-model="manualText" 
                  rows="4" 
                  placeholder="Enter your caption here..."
                  class="w-full px-4 py-3 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-base bg-default text-default placeholder-muted"
                ></textarea>
              </div>

              <div>
                <label class="block text-sm font-medium text-default mb-2">Media *</label>
                <p class="text-xs text-muted mb-2">Upload or paste media here.</p>
                <ImageUploader ref="manualUploaderRef" v-model="manualMediaUrls" :multiple="manualType === 'post'" />
              </div>

              <UAlert v-if="manualError" color="error" variant="soft" :description="manualError" />

              <button 
                @click="submitManual" 
                :disabled="manualSubmitting || !manualText.trim() || manualMediaUrls.length === 0"
                class="w-full flex justify-center items-center px-4 py-3 border border-transparent shadow-sm text-base font-medium rounded-md text-inverted bg-primary hover:bg-primary focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50"
              >
                <Loader2 v-if="manualSubmitting" class="w-5 h-5 mr-2 animate-spin" />
                {{ manualSubmitting ? 'Queueing...' : 'Add to Queue' }}
              </button>
              </div>
          </template>

          <!-- Batch Reels Tab -->
          <template #batch>
            <div class="mt-6 space-y-6">
              <p class="text-sm text-muted mb-6">
                Batch import reels directly to your queue via a CSV file. The file should have a header row with <code>video_url,caption</code>.
              </p>
              
              <div>
                <label class="block text-sm font-medium text-default mb-2">CSV File *</label>
                <input 
                  type="file" 
                  accept=".csv"
                  ref="batchFileInput"
                  @change="handleBatchFileSelect"
                  class="w-full px-4 py-3 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-base bg-default text-default file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-primary file:text-inverted hover:file:bg-primary/90"
                />
              </div>

              <div class="bg-muted p-4 rounded-md border border-default">
                <p class="text-sm font-medium text-default mb-2">Example format:</p>
                <pre class="text-xs text-muted overflow-x-auto">video_url,caption
https://example.com/video1.mp4,"This is my awesome reel #fun"
https://example.com/video2.mp4,"Another reel, this time with a comma!"</pre>
              </div>

              <UAlert v-if="batchError" color="error" variant="soft" :description="batchError" />

              <button 
                @click="submitBatch" 
                :disabled="batchSubmitting || !batchFile"
                class="w-full flex justify-center items-center px-4 py-3 border border-transparent shadow-sm text-base font-medium rounded-md text-inverted bg-primary hover:bg-primary focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50"
              >
                <Loader2 v-if="batchSubmitting" class="w-5 h-5 mr-2 animate-spin" />
                {{ batchSubmitting ? 'Importing...' : 'Batch Import Reels' }}
              </button>
            </div>
          </template>
        </UTabs>
      </div>
    </div>

    <!-- Active Jobs Monitor -->
    <div v-if="activeJobs.length > 0 && connectionStore.activeConnectionId && activeTab === 'ai'" class="bg-default shadow rounded-lg p-6">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold text-default">Processing Jobs</h2>
        <button @click="fetchActiveJobs" class="text-muted hover:text-primary">
          <RefreshCw class="w-5 h-5" />
        </button>
      </div>
      
      <div class="space-y-4">
        <div v-for="job in activeJobs" :key="job.id">
          <UAlert
            :title="job.text"
            :description="job.status === 'error' ? job.errorLog : undefined"
            :color="job.status === 'pending' ? 'warning' : job.status === 'processing' ? 'primary' : 'error'"
            variant="soft"
            :icon="job.status === 'pending' ? 'i-lucide-clock' : job.status === 'processing' ? 'i-lucide-loader-2' : 'i-lucide-alert-circle'"
            :class="{ 'animate-pulse': job.status === 'processing' }"
          >
            <template #title>
              <div class="flex items-center gap-2">
                <UBadge :color="job.status === 'pending' ? 'warning' : job.status === 'processing' ? 'primary' : 'error'" variant="subtle" size="xs" class="uppercase">
                  {{ job.status }}
                </UBadge>
                <span class="text-sm font-medium line-clamp-1">{{ job.text }}</span>
              </div>
            </template>
          </UAlert>
        </div>
        <p class="text-xs text-muted mt-2 text-center">
          Jobs that successfully finish will move to the Pending Queue on the Home dashboard.
        </p>
      </div>
    </div>
  </div>
</template>