<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Save, Settings2, Loader2, Info, Sparkles, X, Trash2, Plug, CheckCircle2, AlertCircle, Radar, Plus } from 'lucide-vue-next'
import { getAuthHeaders } from '../auth'
import ImageUploader from '../components/ImageUploader.vue'
import PasswordInput from '../components/PasswordInput.vue'
import AiTextarea from '../components/AiTextarea.vue'
import { useConnectionStore } from '../store'

const toast = useToast()
const connectionStore = useConnectionStore()

const settings = ref<any>({
  id: null,
  name: '',
  logoImageUrl: '',
  ctaImageUrl: '',
  bufferApiKey: '',
  bufferChannelId: '',
  bufferChannelNetwork: '',
  editorialGuidelines: '',
  postingSlots: [],
  bannedWords: [],
  newsRadarConfig: {
    mode: 'off',
    keywords: [],
    language: 'id',
    customRssUrls: [],
    intervalHours: 4,
    minPendingQueueThreshold: 2,
    defaultTemplateId: 'image:aa.geopolitik:carousel_analysis',
    defaultHeroStyle: 'Dark-Dramatize',
    maxStoriesPerScan: 3,
    lastScannedAt: null
  }
})

const newRadarKeyword = ref('')
const newCustomRssUrl = ref('')

const addRadarKeyword = () => {
  const kw = newRadarKeyword.value.trim()
  if (!kw) return
  if (!settings.value.newsRadarConfig) {
    settings.value.newsRadarConfig = { mode: 'off', keywords: [], language: 'id', customRssUrls: [], intervalHours: 4, minPendingQueueThreshold: 2, defaultTemplateId: 'image:aa.geopolitik:carousel_analysis', defaultHeroStyle: 'Dark-Dramatize', maxStoriesPerScan: 3 }
  }
  if (!Array.isArray(settings.value.newsRadarConfig.keywords)) {
    settings.value.newsRadarConfig.keywords = []
  }
  if (!settings.value.newsRadarConfig.keywords.some((k: string) => k.toLowerCase() === kw.toLowerCase())) {
    settings.value.newsRadarConfig.keywords.push(kw)
  }
  newRadarKeyword.value = ''
}

const removeRadarKeyword = (idx: number) => {
  settings.value.newsRadarConfig?.keywords?.splice(idx, 1)
}

const addCustomRssUrl = () => {
  const url = newCustomRssUrl.value.trim()
  if (!url || !url.startsWith('http')) {
    toast.add({ title: 'Please enter a valid http/https RSS URL.', color: 'warning' })
    return
  }
  if (!Array.isArray(settings.value.newsRadarConfig.customRssUrls)) {
    settings.value.newsRadarConfig.customRssUrls = []
  }
  if (!settings.value.newsRadarConfig.customRssUrls.includes(url)) {
    settings.value.newsRadarConfig.customRssUrls.push(url)
  }
  newCustomRssUrl.value = ''
}

const removeCustomRssUrl = (idx: number) => {
  settings.value.newsRadarConfig?.customRssUrls?.splice(idx, 1)
}

const loading = ref(true)
const saving = ref(false)
const error = ref('')
const isDeleting = ref(false)

const aiPrompt = ref('')
const aiGenerating = ref(false)

const newBannedWord = ref({ word: '', replacement: '', type: 'partial' as 'exact' | 'partial' })

const editingWordIndex = ref<number | null>(null)

const allConnections = ref<any[]>([])
const sourceConnectionId = ref<number | null>(null)

const otherConnections = computed(() => {
  return allConnections.value.filter((c: any) => c.id !== settings.value.id)
})

const copyBannedWords = (mode: 'overwrite' | 'merge') => {
  if (!sourceConnectionId.value) return
  
  const sourceConn = allConnections.value.find((c: any) => c.id === sourceConnectionId.value)
  if (!sourceConn) {
    toast.add({ title: 'Source connection not found.', color: 'error' })
    return
  }

  const sourceWords = sourceConn.bannedWords || []
  if (sourceWords.length === 0) {
    toast.add({ title: `Connection "${sourceConn.name}" has no banned words to copy.`, color: 'warning' })
    return
  }

  if (!settings.value.bannedWords) {
    settings.value.bannedWords = []
  }

  if (mode === 'overwrite') {
    if (settings.value.bannedWords.length > 0 && !confirm(`Are you sure you want to overwrite your current ${settings.value.bannedWords.length} rules with ${sourceWords.length} rules from "${sourceConn.name}"?`)) {
      return
    }
    settings.value.bannedWords = JSON.parse(JSON.stringify(sourceWords))
    toast.add({ title: `Successfully copied ${sourceWords.length} rules from "${sourceConn.name}"! Remember to save settings.`, color: 'success' })
  } else {
    // Merge mode
    const currentWordsLower = settings.value.bannedWords.map((w: any) => w.word.toLowerCase())
    let addedCount = 0
    
    sourceWords.forEach((item: any) => {
      if (!currentWordsLower.includes(item.word.toLowerCase())) {
        settings.value.bannedWords.push(JSON.parse(JSON.stringify(item)))
        addedCount++
      }
    })
    
    if (addedCount === 0) {
      toast.add({ title: 'All rules from the source connection already exist in this connection.', color: 'info' })
    } else {
      toast.add({ title: `Successfully merged ${addedCount} new rules from "${sourceConn.name}"! Remember to save settings.`, color: 'success' })
    }
  }
  
  // Reset selection
  sourceConnectionId.value = null
}

const addBannedWord = () => {
  if (!newBannedWord.value.word.trim()) return
  
  if (!settings.value.bannedWords) {
    settings.value.bannedWords = []
  }
  
  // Adding a new word
  if (settings.value.bannedWords.some((w: any) => w.word.toLowerCase() === newBannedWord.value.word.toLowerCase().trim())) {
    toast.add({ title: 'This word is already in the banned list.', color: 'error' })
    return
  }

  settings.value.bannedWords.push({
    word: newBannedWord.value.word.trim(),
    replacement: newBannedWord.value.replacement.trim() || '***',
    type: newBannedWord.value.type
  })

  // Reset form
  newBannedWord.value = { word: '', replacement: '', type: 'partial' }
}

const editingWordState = ref({ word: '', replacement: '', type: 'partial' as 'exact' | 'partial' })

const editBannedWord = (index: number) => {
  const item = settings.value.bannedWords[index]
  editingWordState.value = { ...item }
  editingWordIndex.value = index
}

const cancelEditBannedWord = () => {
  editingWordIndex.value = null
}

const saveEditedWord = () => {
  if (editingWordIndex.value === null) return
  if (!editingWordState.value.word.trim()) return

  // Check if new word already exists elsewhere in the list
  if (settings.value.bannedWords.some((w: any, idx: number) => 
      idx !== editingWordIndex.value && 
      w.word.toLowerCase() === editingWordState.value.word.toLowerCase().trim())) {
    toast.add({ title: 'This word is already in the banned list.', color: 'error' })
    return
  }
  
  settings.value.bannedWords[editingWordIndex.value] = {
    word: editingWordState.value.word.trim(),
    replacement: editingWordState.value.replacement.trim() || '***',
    type: editingWordState.value.type
  }
  editingWordIndex.value = null
}

const removeBannedWord = (index: number) => {
  settings.value.bannedWords.splice(index, 1)
  if (editingWordIndex.value === index) {
    cancelEditBannedWord()
  } else if (editingWordIndex.value !== null && editingWordIndex.value > index) {
    editingWordIndex.value--
  }
}

const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const slotsByDay = computed(() => {
  const result: Record<string, any[]> = {}
  daysOfWeek.forEach(d => result[d] = [])
  
  if (settings.value.postingSlots) {
    settings.value.postingSlots.forEach((slot: any) => {
      // Find proper capitalization
      const targetDay = daysOfWeek.find(d => d.toLowerCase() === slot.day.toLowerCase())
      if (targetDay) {
        result[targetDay].push(slot)
      }
    })
  }

  // Sort times chronologically
  daysOfWeek.forEach(d => {
    result[d].sort((a, b) => a.time.localeCompare(b.time))
  })

  return result
})

// Format "HH:mm" to 12-hour AM/PM
const formatTime = (time24: string) => {
  if (!time24) return ''
  const [h, m] = time24.split(':')
  let hours = parseInt(h, 10)
  const ampm = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12 || 12
  return `${hours.toString().padStart(2, '0')}:${m} ${ampm}`
}

const removeSlot = (slotToRemove: any) => {
  settings.value.postingSlots = settings.value.postingSlots.filter(
    (s: any) => !(s.day.toLowerCase() === slotToRemove.day.toLowerCase() && s.time === slotToRemove.time)
  )
}

const clearAllSlots = () => {
  if (confirm('Are you sure you want to delete all posting slots?')) {
    settings.value.postingSlots = []
  }
}

const generateSlots = async () => {
  if (!aiPrompt.value.trim()) return
  if (!settings.value.id) return
  
  aiGenerating.value = true
  try {
    const res = await fetch(`/api/connections/${settings.value.id}/slots/generate`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: aiPrompt.value })
    })
    
    if (res.status === 401) throw new Error('Unauthorized')
    
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to generate slots')
    
    settings.value.postingSlots = data.slots
    aiPrompt.value = ''
  } catch (err: any) {
    toast.add({ title: err.message, color: 'error' })
  } finally {
    aiGenerating.value = false
  }
}

const fetchSettings = async () => {
  if (!connectionStore.activeConnectionId) {
    loading.value = false
    return
  }

  loading.value = true
  error.value = ''
  try {
    const res = await fetch('/api/connections', { headers: getAuthHeaders() })
    if (res.status === 401) throw new Error('Unauthorized')
    if (!res.ok) throw new Error('Failed to load settings')
    const connections = await res.json()
    allConnections.value = connections
    const activeSettings = connections.find((c: any) => c.id === connectionStore.activeConnectionId)
    
    if (activeSettings) {
        settings.value = {
          ...settings.value,
          ...activeSettings,
          newsRadarConfig: {
            mode: 'off',
            keywords: [],
            language: 'id',
            customRssUrls: [],
            intervalHours: 4,
            minPendingQueueThreshold: 2,
            defaultTemplateId: 'image:aa.geopolitik:carousel_analysis',
            defaultHeroStyle: 'Dark-Dramatize',
            maxStoriesPerScan: 3,
            ...(activeSettings.newsRadarConfig || {})
          }
        }
    } else {
        error.value = 'Connection not found'
    }
  } catch (err: any) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

watch(() => connectionStore.activeConnectionId, () => {
  fetchSettings()
}, { immediate: true })

const tabItems = [
  { label: 'General', icon: 'i-lucide-settings', slot: 'general' as const },
  { label: 'Media Assets', icon: 'i-lucide-image', slot: 'media' as const },
  { label: 'Publishing', icon: 'i-lucide-calendar', slot: 'publishing' as const },
  { label: 'Editorial', icon: 'i-lucide-pen-tool', slot: 'editorial' as const },
  { label: 'News Radar', icon: 'i-lucide-radar', slot: 'radar' as const },
  { label: 'Moderation', icon: 'i-lucide-shield', slot: 'moderation' as const },
  { label: 'API Keys', icon: 'i-lucide-key', slot: 'keys' as const }
]

const saveSettings = async () => {
  if (!settings.value.id) return

  saving.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/connections/${settings.value.id}`, {
      method: 'PUT',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(settings.value)
    })
    
    if (res.status === 401) throw new Error('Unauthorized')
    if (!res.ok) throw new Error('Failed to save settings')
    
    toast.add({ title: 'Connection settings saved successfully!', color: 'success' })
    fetchSettings() // refresh to get updated auto-detected name/network if any
  } catch (err: any) {
    error.value = err.message
    toast.add({ title: err.message, color: 'error' })
  } finally {
    saving.value = false
  }
}

const deleteConnection = async () => {
  if (!settings.value.id) return
  if (!confirm('Are you sure you want to delete this connection? This action cannot be undone and will delete all associated queue items and ideas.')) return

  isDeleting.value = true
  try {
    const res = await fetch(`/api/connections/${settings.value.id}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    })
    
    if (res.status === 401) throw new Error('Unauthorized')
    if (!res.ok) throw new Error('Failed to delete connection')
    
    toast.add({ title: 'Connection deleted successfully!', color: 'success' })
    connectionStore.setActiveConnection(null)
    window.location.reload()
  } catch (err: any) {
    toast.add({ title: err.message, color: 'error' })
  } finally {
    isDeleting.value = false
  }
}

const testingBuffer = ref(false)
const bufferTestResult = ref<{ success: boolean; message: string } | null>(null)

const testBufferConnection = async () => {
  if (!settings.value.bufferApiKey || !settings.value.bufferChannelId) {
    toast.add({
      title: 'Missing Credentials',
      description: 'Please enter both Buffer API Key and Channel ID.',
      color: 'warning'
    })
    return
  }

  testingBuffer.value = true
  bufferTestResult.value = null
  try {
    const res = await fetch('/api/connections/test-buffer', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bufferApiKey: settings.value.bufferApiKey,
        bufferChannelId: settings.value.bufferChannelId
      })
    })

    const data = await res.json()
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to connect to Buffer')
    }

    settings.value.bufferChannelNetwork = data.network
    bufferTestResult.value = {
      success: true,
      message: `Connected successfully to "${data.name}" (${data.network.toUpperCase()})`
    }
    toast.add({
      title: 'Buffer Connected!',
      description: `Channel "${data.name}" verified (${data.network.toUpperCase()}).`,
      color: 'success'
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    bufferTestResult.value = {
      success: false,
      message
    }
    toast.add({
      title: 'Connection Failed',
      description: message,
      color: 'error'
    })
  } finally {
    testingBuffer.value = false
  }
}
</script>

<template>
  <div class="container mx-auto space-y-6">
    <div class="bg-default shadow rounded-lg p-6">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold text-default flex items-center">
          <Settings2 class="w-6 h-6 mr-3 text-primary" />
          Connection Settings
        </h1>
        <button 
          v-if="settings.id"
          @click="deleteConnection" 
          :disabled="isDeleting"
          class="flex items-center text-sm text-error hover:text-red-700 transition"
        >
           <Loader2 v-if="isDeleting" class="w-4 h-4 mr-1 animate-spin" />
           <Trash2 v-else class="w-4 h-4 mr-1" />
           Delete Connection
        </button>
      </div>

      <div v-if="!connectionStore.activeConnectionId" class="text-center py-10 text-muted">
         Please select or create a connection from the sidebar.
      </div>
      <div v-else-if="loading" class="flex justify-center py-10">
        <Loader2 class="w-8 h-8 text-primary animate-spin" />
      </div>

      <UAlert 
        v-else-if="error" 
        color="error" 
        variant="soft" 
        :description="error" 
        class="mb-6" 
      />

      <div v-else class="space-y-6">
        <UTabs :items="tabItems" class="w-full">

          <template #general>
             <div class="mt-6 space-y-6">
              <h2 class="text-lg font-bold text-default border-b border-default pb-2">General</h2>
              <div>
                <label class="block text-sm font-medium text-default mb-2">Connection Name</label>
                <input v-model="settings.name" type="text" class="w-full px-4 py-2 border border-default rounded-md shadow-sm text-sm bg-default text-default" placeholder="e.g. My Instagram" />
                <p class="text-xs text-muted mt-1">A recognizable name for this connection. If left blank, it will auto-detect from Buffer.</p>
              </div>
             </div>
          </template>

          <template #media>
            <div class="mt-6 space-y-6">
              <h2 class="text-lg font-bold text-default border-b border-default pb-2">Media Assets</h2>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label class="block text-sm font-medium text-default mb-2">Watermark Logo URL</label>
                  <ImageUploader v-model="settings.logoImageUrl" />
                </div>
                <div>
                  <label class="block text-sm font-medium text-default mb-2">CTA Slide URL (Final Slide)</label>
                  <ImageUploader v-model="settings.ctaImageUrl" />
                </div>
              </div>
            </div>
          </template>

          <template #publishing>
            <div class="mt-6 space-y-6">
              <h2 class="text-lg font-bold text-default border-b border-default pb-2">Posting Slots</h2>
              <UAlert
                :icon="Info"
                color="neutral"
                variant="subtle"
                description="Your posting slots determine exactly when the worker will publish the next item in the Posts Queue. Add slots below using Natural Language AI!"
              />

              <!-- Slots Grid -->
              <div class="border border-default rounded-lg overflow-hidden bg-default flex flex-col md:flex-row">
                <div v-for="day in daysOfWeek" :key="day" class="flex-1 border-b md:border-b-0 md:border-r border-default last:border-0 min-w-0">
                  <div class="bg-muted py-3 text-center border-b border-default">
                    <span class="text-sm font-semibold text-default">{{ day }}</span>
                  </div>
                  <div class="p-2 space-y-2 min-h-[100px] flex flex-col items-center">
                    <div v-if="slotsByDay[day].length === 0" class="text-xs text-muted py-4 italic">
                      No slots
                    </div>
                    <div v-for="(slot, i) in slotsByDay[day]" :key="i" class="group relative bg-default border border-default rounded shadow-sm px-3 py-2 text-sm font-medium text-default hover:border-default transition flex items-center justify-center w-full">
                      {{ formatTime(slot.time) }}
                      <button @click="removeSlot(slot)" class="absolute -right-1 -top-1 bg-error text-error rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition shadow-sm hover:bg-error">
                        <X class="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Add slots with AI -->
              <div class="bg-muted rounded-lg p-4 border border-default flex flex-col sm:flex-row items-center justify-between gap-4">
                <div class="flex-1 w-full">
                  <label class="block text-xs font-medium text-muted mb-1 uppercase tracking-wider">Add slots using AI</label>
                  <input 
                    v-model="aiPrompt" 
                    @keyup.enter="generateSlots"
                    type="text" 
                    placeholder="e.g. Everyday 3 times between 9am to 9pm"
                    class="w-full px-4 py-2.5 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-sm bg-default text-default placeholder-muted"
                  />
                </div>
                <div class="flex items-center gap-3 w-full sm:w-auto mt-2 sm:mt-5">
                  <button 
                    @click="generateSlots" 
                    :disabled="aiGenerating || !aiPrompt.trim()"
                    class="flex-1 sm:flex-none inline-flex items-center justify-center px-4 py-2.5 border border-transparent shadow-sm text-sm font-medium rounded-md text-inverted bg-primary hover:bg-primary focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50"
                  >
                    <Loader2 v-if="aiGenerating" class="w-4 h-4 mr-2 animate-spin" />
                    <Sparkles v-else class="w-4 h-4 mr-2" />
                    Generate
                  </button>
                  <button @click="clearAllSlots" class="text-sm font-medium text-error hover:text-error py-2.5 px-2">
                    Clear All
                  </button>
                </div>
              </div>
            </div>
          </template>

          <template #editorial>
            <div class="mt-6 space-y-6">
              <h2 class="text-lg font-bold text-default border-b border-default pb-2">Editorial Guidelines</h2>
              <UAlert
                :icon="Info"
                color="neutral"
                variant="subtle"
                description="Provide explicit instructions to the Content Writer AI on how to frame the news, tone of voice, perspective, and general editorial stance (e.g., highlighting specific geopolitical perspectives). Note: The Research AI will always remain strictly neutral and objective to gather unbiased facts first. This overwrites the default `.env` fallback."
              />
              <AiTextarea 
                v-model="settings.editorialGuidelines" 
                :rows="6" 
                placeholder="e.g. Your reporting should maintain a professional and highly informative journalistic tone. Focus on delivering factual news while highlighting perspectives from the Global South..."
                guidancePlaceholder="e.g., make it more aggressive and punchy"
                aiContext="This text represents the global editorial guidelines and framing instructions for a news AI agent. It dictates how the AI should write its content, including its tone, perspective, and biases."
              />
            </div>
          </template>

          <template #radar>
            <div class="mt-6 space-y-6" v-if="settings.newsRadarConfig">
              <div class="flex items-center justify-between border-b border-default pb-2">
                <h2 class="text-lg font-bold text-default flex items-center gap-2">
                  <Radar class="w-5 h-5 text-primary" />
                  Autonomous News Radar & AI Chief Editor
                </h2>
                <span v-if="settings.newsRadarConfig.lastScannedAt" class="text-xs text-muted">
                  Last scanned: {{ new Date(settings.newsRadarConfig.lastScannedAt).toLocaleString('id-ID') }}
                </span>
              </div>

              <!-- 1. Autopilot Mode Selector -->
              <div>
                <label class="block text-sm font-semibold text-default mb-3">1. Operation Mode (Autopilot Level)</label>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div
                    @click="settings.newsRadarConfig.mode = 'off'"
                    class="p-4 rounded-xl border cursor-pointer transition"
                    :class="settings.newsRadarConfig.mode === 'off' ? 'border-primary bg-primary/8 ring-1 ring-primary/30' : 'border-default bg-default hover:bg-muted'"
                  >
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-sm font-bold text-default">Manual Scan Only</span>
                      <input type="radio" :checked="settings.newsRadarConfig.mode === 'off'" class="text-primary" />
                    </div>
                    <p class="text-xs text-muted">Only fetches & ranks news when you click "Scan Breaking News" on the Ideas page.</p>
                  </div>

                  <div
                    @click="settings.newsRadarConfig.mode = 'semi_auto'"
                    class="p-4 rounded-xl border cursor-pointer transition"
                    :class="settings.newsRadarConfig.mode === 'semi_auto' ? 'border-primary bg-primary/8 ring-1 ring-primary/30' : 'border-default bg-default hover:bg-muted'"
                  >
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-sm font-bold text-default">Auto-Curate to Ideas</span>
                      <input type="radio" :checked="settings.newsRadarConfig.mode === 'semi_auto'" class="text-primary" />
                    </div>
                    <p class="text-xs text-muted">Periodically scans RSS feeds, clusters duplicate articles, and places Top picks in your Ideas inbox for 1-click approval.</p>
                  </div>

                  <div
                    @click="settings.newsRadarConfig.mode = 'autopilot'"
                    class="p-4 rounded-xl border cursor-pointer transition"
                    :class="settings.newsRadarConfig.mode === 'autopilot' ? 'border-amber-500 bg-amber-500/8 ring-1 ring-amber-500/30' : 'border-default bg-default hover:bg-muted'"
                  >
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-sm font-bold text-amber-500">Full Autopilot Queue</span>
                      <input type="radio" :checked="settings.newsRadarConfig.mode === 'autopilot'" class="text-amber-500" />
                    </div>
                    <p class="text-xs text-muted">When your Pending Queue drops below threshold, automatically picks the #1 story and generates a ready-to-publish Carousel!</p>
                  </div>
                </div>
              </div>

              <!-- 2. Topic Keywords (Google News RSS Builder) -->
              <div class="bg-muted/60 rounded-xl p-4 border border-default space-y-4">
                <div>
                  <label class="block text-sm font-semibold text-default">2. Topic Radar Keywords (Google News Auto-Builder)</label>
                  <p class="text-xs text-muted mt-0.5">Add topics or keywords for this account. Redaksi.AI automatically builds and decodes Google News RSS feeds from these topics.</p>
                </div>

                <div class="flex flex-wrap gap-2">
                  <span
                    v-for="(kw, idx) in settings.newsRadarConfig.keywords"
                    :key="idx"
                    class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-primary/15 text-primary border border-primary/30"
                  >
                    {{ kw }}
                    <button type="button" @click="removeRadarKeyword(Number(idx))" class="hover:text-error cursor-pointer">
                      <X class="w-3.5 h-3.5" />
                    </button>
                  </span>
                  <span v-if="!settings.newsRadarConfig.keywords?.length" class="text-xs text-muted italic py-1">
                    No custom keywords set (will auto-infer from Editorial Guidelines).
                  </span>
                </div>

                <div class="flex flex-col sm:flex-row gap-3">
                  <input
                    v-model="newRadarKeyword"
                    @keyup.enter.prevent="addRadarKeyword"
                    type="text"
                    placeholder="e.g. Geopolitik, Timur Tengah, Laut China Selatan, BRICS..."
                    class="flex-1 px-3.5 py-2 border border-default rounded-md text-sm bg-default text-default"
                  />
                  <button
                    type="button"
                    @click="addRadarKeyword"
                    class="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-primary text-inverted hover:bg-primary/90 cursor-pointer"
                  >
                    <Plus class="w-4 h-4" />
                    Add Topic
                  </button>
                  <select
                    v-model="settings.newsRadarConfig.language"
                    class="px-3 py-2 border border-default rounded-md text-sm bg-default text-default"
                  >
                    <option value="id">🇮🇩 Bahasa Indonesia (ID)</option>
                    <option value="en">🌐 Global English (US/Intl)</option>
                  </select>
                </div>
              </div>

              <!-- 3. Schedule & Autopilot Parameters -->
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label class="block text-xs font-semibold text-default mb-1">Scan Interval (Hours)</label>
                  <input
                    v-model.number="settings.newsRadarConfig.intervalHours"
                    type="number"
                    min="1"
                    max="48"
                    class="w-full px-3 py-2 border border-default rounded-md text-sm bg-default text-default"
                  />
                  <p class="text-[11px] text-muted mt-1">How often background radar scans RSS.</p>
                </div>
                <div>
                  <label class="block text-xs font-semibold text-default mb-1">Stories Picked per Scan</label>
                  <input
                    v-model.number="settings.newsRadarConfig.maxStoriesPerScan"
                    type="number"
                    min="1"
                    max="5"
                    class="w-full px-3 py-2 border border-default rounded-md text-sm bg-default text-default"
                  />
                  <p class="text-[11px] text-muted mt-1">Top 1 to 5 viral story clusters per scan.</p>
                </div>
                <div>
                  <label class="block text-xs font-semibold text-default mb-1">Autopilot Min Queue Threshold</label>
                  <input
                    v-model.number="settings.newsRadarConfig.minPendingQueueThreshold"
                    type="number"
                    min="1"
                    max="20"
                    class="w-full px-3 py-2 border border-default rounded-md text-sm bg-default text-default"
                  />
                  <p class="text-[11px] text-muted mt-1">Auto-generate when Pending Queue &lt; this number.</p>
                </div>
              </div>

              <!-- 4. Custom RSS Feeds -->
              <div class="space-y-3">
                <label class="block text-sm font-semibold text-default">3. Additional Custom RSS Feeds (Optional)</label>
                <div class="flex gap-2">
                  <input
                    v-model="newCustomRssUrl"
                    @keyup.enter.prevent="addCustomRssUrl"
                    type="url"
                    placeholder="https://www.antaranews.com/rss/dunia.xml"
                    class="flex-1 px-3.5 py-2 border border-default rounded-md text-sm bg-default text-default"
                  />
                  <button
                    type="button"
                    @click="addCustomRssUrl"
                    class="px-4 py-2 text-xs font-semibold rounded-md border border-default bg-default hover:bg-muted text-default cursor-pointer"
                  >
                    + Add Feed URL
                  </button>
                </div>
                <ul v-if="settings.newsRadarConfig.customRssUrls?.length" class="space-y-1.5">
                  <li
                    v-for="(rssUrl, idx) in settings.newsRadarConfig.customRssUrls"
                    :key="idx"
                    class="flex items-center justify-between px-3 py-2 rounded-md bg-muted border border-default text-xs font-mono text-default"
                  >
                    <span class="truncate mr-2">{{ rssUrl }}</span>
                    <button type="button" @click="removeCustomRssUrl(Number(idx))" class="text-error hover:underline shrink-0 cursor-pointer">
                      Remove
                    </button>
                  </li>
                </ul>
              </div>
            </div>
          </template>

          <template #moderation>
            <div class="mt-6 space-y-6">
              <h2 class="text-lg font-bold text-default border-b border-default pb-2">Content Moderation</h2>
              <UAlert
                :icon="Info"
                color="neutral"
                variant="subtle"
                description="The AI Writer will be explicitly instructed to avoid these words and use the replacements instead. As a final fallback, the text will be hard-censored just before rendering/publishing."
              />

              <!-- Copy from Another Connection -->
              <div v-if="otherConnections.length > 0" class="bg-muted rounded-lg p-4 border border-default space-y-4">
                <h3 class="text-sm font-semibold text-default flex items-center">
                  <Sparkles class="w-4 h-4 mr-2 text-primary" />
                  Copy Rules from Another Connection
                </h3>
                <div class="flex flex-col sm:flex-row gap-4 items-end">
                  <div class="flex-1 w-full">
                    <label class="block text-xs font-medium text-muted mb-1">Source Connection</label>
                    <select 
                      v-model="sourceConnectionId"
                      class="w-full px-3 py-2 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-sm bg-default text-default"
                    >
                      <option :value="null" disabled>Select connection...</option>
                      <option v-for="conn in otherConnections" :key="conn.id" :value="conn.id">
                        {{ conn.name }} ({{ conn.bannedWords?.length || 0 }} rules)
                      </option>
                    </select>
                  </div>
                  <div class="w-full sm:w-auto flex gap-2">
                    <button 
                      @click="copyBannedWords('merge')"
                      :disabled="!sourceConnectionId"
                      class="flex-1 sm:flex-initial inline-flex items-center justify-center px-4 py-2 border border-default shadow-sm text-sm font-medium rounded-md text-default bg-default hover:bg-muted focus:outline-none disabled:opacity-50 cursor-pointer"
                    >
                      Merge / Append
                    </button>
                    <button 
                      @click="copyBannedWords('overwrite')"
                      :disabled="!sourceConnectionId"
                      class="flex-1 sm:flex-initial inline-flex items-center justify-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-inverted bg-primary hover:bg-primary/95 focus:outline-none disabled:opacity-50 cursor-pointer"
                    >
                      Overwrite
                    </button>
                  </div>
                </div>
              </div>

              <div class="bg-muted rounded-lg p-4 border border-default flex flex-col md:flex-row gap-4 items-end">
                <div class="flex-1 w-full">
                  <label class="block text-xs font-medium text-muted mb-1">Banned Word</label>
                  <input 
                    v-model="newBannedWord.word" 
                    type="text" 
                    placeholder="e.g. bunuh"
                    @keyup.enter="addBannedWord"
                    class="w-full px-3 py-2 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-sm bg-default text-default"
                  />
                </div>
                <div class="flex-1 w-full">
                  <label class="block text-xs font-medium text-muted mb-1">Replacement</label>
                  <input 
                    v-model="newBannedWord.replacement" 
                    type="text" 
                    placeholder="e.g. b*nuh"
                    @keyup.enter="addBannedWord"
                    class="w-full px-3 py-2 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-sm bg-default text-default"
                  />
                </div>
                <div class="w-full md:w-auto">
                  <label class="block text-xs font-medium text-muted mb-1">Match Type</label>
                  <select 
                    v-model="newBannedWord.type"
                    class="w-full px-3 py-2 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-sm bg-default text-default"
                  >
                    <option value="partial">Partial (Matches inside words)</option>
                    <option value="exact">Exact (Whole word only)</option>
                  </select>
                </div>
                <div class="w-full md:w-auto flex gap-2">
                  <button 
                    @click="addBannedWord" 
                    class="flex-1 inline-flex items-center justify-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-inverted bg-primary hover:bg-primary focus:outline-none"
                  >
                    Add Rule
                  </button>
                </div>
              </div>

              <!-- Dictionary List -->
              <div v-if="settings.bannedWords && settings.bannedWords.length > 0" class="border border-default rounded-lg overflow-hidden bg-default">
                <ul class="divide-y divide-default max-h-96 overflow-y-auto">
                  <li v-for="(item, index) in settings.bannedWords" :key="index" class="p-3 sm:px-4 hover:bg-muted transition-colors" :class="{'bg-muted': editingWordIndex === index}">
                    <!-- Inline Edit Form -->
                    <div v-if="editingWordIndex === index" class="flex flex-col md:flex-row gap-3 items-center w-full">
                      <div class="flex-1 w-full">
                        <input 
                          v-model="editingWordState.word" 
                          type="text" 
                          placeholder="Banned Word"
                          @keyup.enter="saveEditedWord"
                          class="w-full px-3 py-1.5 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-sm bg-default text-default"
                        />
                      </div>
                      <div class="text-muted hidden md:block">→</div>
                      <div class="flex-1 w-full">
                        <input 
                          v-model="editingWordState.replacement" 
                          type="text" 
                          placeholder="Replacement"
                          @keyup.enter="saveEditedWord"
                          class="w-full px-3 py-1.5 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-sm bg-default text-default"
                        />
                      </div>
                      <div class="w-full md:w-auto">
                        <select 
                          v-model="editingWordState.type"
                          class="w-full px-3 py-1.5 border border-default rounded-md shadow-sm focus:ring-primary focus:border-primary text-sm bg-default text-default"
                        >
                          <option value="partial">Partial</option>
                          <option value="exact">Exact</option>
                        </select>
                      </div>
                      <div class="flex gap-2 w-full md:w-auto mt-2 md:mt-0 justify-end">
                        <button @click="saveEditedWord" class="px-3 py-1.5 text-xs font-medium text-inverted bg-primary rounded-md hover:bg-primary/90 transition-colors">Save</button>
                        <button @click="cancelEditBannedWord" class="px-3 py-1.5 text-xs font-medium text-default bg-default border border-default rounded-md hover:bg-muted transition-colors">Cancel</button>
                      </div>
                    </div>

                    <!-- Display Mode -->
                    <div v-else class="flex items-center justify-between w-full cursor-pointer" @click="editBannedWord(Number(index))">
                      <div class="flex items-center gap-2 sm:gap-4 overflow-hidden">
                        <span class="font-medium text-error truncate">{{ item.word }}</span>
                        <span class="text-muted text-xs">→</span>
                        <span class="font-mono text-sm text-success truncate">{{ item.replacement }}</span>
                        <span class="text-xs px-2 py-0.5 rounded-full bg-elevated text-muted hidden sm:inline-block">
                          {{ item.type }}
                        </span>
                      </div>
                      <button @click.stop="removeBannedWord(Number(index))" class="text-muted hover:text-error flex-shrink-0 ml-4 p-1 rounded-md hover:bg-default transition-colors">
                        <X class="w-4 h-4" />
                      </button>
                    </div>
                  </li>
                </ul>
              </div>
              <div v-else class="text-center py-6 border border-dashed border-default rounded-lg text-muted text-sm">
                No moderation rules configured.
              </div>
            </div>
          </template>

          <template #keys>
            <div class="mt-6 space-y-6">
              <div class="flex items-center justify-between border-b border-default pb-2">
                <h2 class="text-lg font-bold text-default">API Keys & Tokens</h2>
                <button
                  type="button"
                  @click="testBufferConnection"
                  :disabled="testingBuffer || !settings.bufferApiKey || !settings.bufferChannelId"
                  class="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md text-inverted bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer"
                >
                  <Loader2 v-if="testingBuffer" class="w-3.5 h-3.5 animate-spin" />
                  <Plug v-else class="w-3.5 h-3.5" />
                  {{ testingBuffer ? 'Testing...' : 'Test Connection' }}
                </button>
              </div>
              
              <div class="space-y-4">
                <div>
                  <label class="block text-sm font-medium text-default mb-2">Buffer API Key (Bearer)</label>
                  <PasswordInput v-model="settings.bufferApiKey" placeholder="1/abcdef..." />
                </div>

                <div>
                  <label class="block text-sm font-medium text-default mb-2">Buffer Channel ID</label>
                  <PasswordInput v-model="settings.bufferChannelId" placeholder="60abc123..." />
                </div>
                
                <div v-if="settings.bufferChannelNetwork">
                  <label class="block text-sm font-medium text-default mb-2">Buffer Channel Network (Auto-detected)</label>
                  <input type="text" disabled :value="settings.bufferChannelNetwork" class="w-full px-4 py-2 border border-default rounded-md shadow-sm text-sm bg-muted text-muted uppercase cursor-not-allowed" />
                </div>

                <!-- Test Connection Status Box -->
                <div v-if="bufferTestResult" class="p-3.5 rounded-lg border text-sm flex items-start gap-2.5 transition" :class="bufferTestResult.success ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400' : 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400'">
                  <CheckCircle2 v-if="bufferTestResult.success" class="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <AlertCircle v-else class="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <div class="flex-1">
                    <p class="font-medium">{{ bufferTestResult.success ? 'Koneksi Berhasil' : 'Koneksi Gagal' }}</p>
                    <p class="text-xs opacity-90 mt-0.5">{{ bufferTestResult.message }}</p>
                  </div>
                </div>

                <div class="pt-2">
                  <button
                    type="button"
                    @click="testBufferConnection"
                    :disabled="testingBuffer || !settings.bufferApiKey || !settings.bufferChannelId"
                    class="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 border border-default shadow-sm text-sm font-medium rounded-md text-default bg-default hover:bg-muted focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer"
                  >
                    <Loader2 v-if="testingBuffer" class="w-4 h-4 animate-spin" />
                    <Plug v-else class="w-4 h-4" />
                    {{ testingBuffer ? 'Testing Connection to Buffer...' : 'Test Buffer Connection' }}
                  </button>
                </div>
              </div>
            </div>
          </template>
        </UTabs>

        <div class="pt-6 border-t border-default mt-8">
          <button 
            @click="saveSettings" 
            :disabled="saving"
            class="w-full flex justify-center items-center px-4 py-3 border border-transparent shadow-sm text-base font-medium rounded-md text-inverted bg-primary hover:bg-primary focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50"
          >
            <Loader2 v-if="saving" class="w-5 h-5 mr-2 animate-spin" />
            <Save v-else class="w-5 h-5 mr-2" />
            {{ saving ? 'Saving...' : 'Save Settings' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>