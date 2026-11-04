<script setup lang="ts">
import { ref, computed } from 'vue'
import { Bot, Copy, Check, Eye, EyeOff, Terminal, Sparkles, X, Cpu, Layers } from 'lucide-vue-next'
import { dashboardPassword } from '../auth'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const toast = useToast()
const activeTab = ref<'prompt' | 'json' | 'tools'>('prompt')
const selectedAgent = ref<'omp' | 'claude' | 'cursor' | 'universal'>('omp')
const showApiKey = ref(false)
const copiedKey = ref<string | null>(null)

const apiUrl = computed(() => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }
  return 'https://ignewsbot.rekapancatama.com'
})

const effectiveApiKey = computed(() => {
  return dashboardPassword.value || '<YOUR_REDAKSI_API_KEY>'
})

const displayedApiKey = computed(() => {
  if (showApiKey.value || !dashboardPassword.value) return effectiveApiKey.value
  const pwd = dashboardPassword.value
  if (pwd.length <= 4) return '••••'
  return `${pwd.slice(0, 2)}${'•'.repeat(Math.min(12, pwd.length - 4))}${pwd.slice(-2)}`
})

const agentTargets = [
  { id: 'omp' as const, label: 'OMP Agent', configPath: '~/.omp/agent/mcp.json' },
  { id: 'claude' as const, label: 'Claude Code / Desktop', configPath: '~/.claude.json or claude_desktop_config.json' },
  { id: 'cursor' as const, label: 'Cursor / Windsurf', configPath: '~/.cursor/mcp.json' },
  { id: 'universal' as const, label: 'Any MCP Client', configPath: 'mcp.json' },
]

const buildAutoSetupPrompt = (includeRealKey: boolean) => {
  const keyToUse = includeRealKey ? effectiveApiKey.value : displayedApiKey.value
  const target = agentTargets.find((a) => a.id === selectedAgent.value) || agentTargets[0]

  return `Tolong pasang dan aktifkan MCP Server "redaksi-ai" (Redaksi.AI Autonomous Newsroom & Instagram Carousel Studio) di konfigurasi MCP saya (${target.configPath}).

Ikuti langkah otomatis berikut tanpa perlu git clone repo:
1. Buat folder \`~/.redaksi-ai\` jika belum ada, lalu download script bridge MCP zero-dependency dari:
   URL: ${apiUrl.value}/mcp-bridge.mjs
   Simpan ke: \`~/.redaksi-ai/mcp-bridge.mjs\`

2. Tambahkan atau update entry \`"redaksi-ai"\` di dalam \`"mcpServers"\` pada file \`${target.configPath}\` (pertahankan server MCP lain yang sudah ada):
\`\`\`json
{
  "mcpServers": {
    "redaksi-ai": {
      "type": "stdio",
      "command": "node",
      "args": [
        "<PATH_ABSOLUT_KE_HOME>/.redaksi-ai/mcp-bridge.mjs"
      ],
      "env": {
        "REDAKSI_API_URL": "${apiUrl.value}",
        "REDAKSI_API_KEY": "${keyToUse}"
      },
      "enabled": true
    }
  }
}
\`\`\`
(Ganti \`<PATH_ABSOLUT_KE_HOME>\` dengan path absolut home directory user di OS ini, misalnya \`C:/Users/nama/.redaksi-ai/mcp-bridge.mjs\` di Windows atau \`/Users/nama/.redaksi-ai/mcp-bridge.mjs\` di macOS/Linux).

3. Verifikasi instalasi dengan menjalankan tes handshake JSON-RPC \`tools/list\` atau memanggil tool \`redaksi_list_accounts\` untuk memastikan semua 23 tools Redaksi.AI sudah terhubung.`
}

const displayedPrompt = computed(() => buildAutoSetupPrompt(showApiKey.value))

const buildManualJson = (includeRealKey: boolean) => {
  const keyToUse = includeRealKey ? effectiveApiKey.value : displayedApiKey.value
  return JSON.stringify(
    {
      mcpServers: {
        'redaksi-ai': {
          type: 'stdio',
          command: 'node',
          args: ['~/.redaksi-ai/mcp-bridge.mjs'],
          env: {
            REDAKSI_API_URL: apiUrl.value,
            REDAKSI_API_KEY: keyToUse,
          },
          enabled: true,
        },
      },
    },
    null,
    2
  )
}

const displayedManualJson = computed(() => buildManualJson(showApiKey.value))

const copyText = async (text: string, key: string, label: string) => {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    toast.add({
      title: `${label} Copied!`,
      description: 'Includes your live API URL and credentials. Paste it directly into your AI Agent.',
      color: 'success',
    })
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = null
    }, 2500)
  } catch {
    toast.add({ title: 'Failed to copy to clipboard', color: 'error' })
  }
}

const toolGroups = [
  {
    domain: '1. Account, Brand, Slots & Censorship (7 Tools)',
    tools: [
      { name: 'redaksi_list_accounts', desc: 'List all accounts with slot counts, banned words, & Radar mode' },
      { name: 'redaksi_get_account', desc: 'Read full settings, guidelines, slots, & Radar config of 1 account' },
      { name: 'redaksi_create_account', desc: 'Create a new account connection + Buffer validation' },
      { name: 'redaksi_update_account', desc: 'Update name, logo, CTA slide, editorial guidelines, or Buffer keys' },
      { name: 'redaksi_manage_posting_slots', desc: 'Get, set, clear, or AI-generate posting schedule slots' },
      { name: 'redaksi_manage_banned_words', desc: 'Add, remove, list, or copy/merge censorship word rules' },
      { name: 'redaksi_delete_account', desc: 'Delete an account connection and its queue' },
    ],
  },
  {
    domain: '2. Newsroom Radar & Idea Desk (4 Tools)',
    tools: [
      { name: 'redaksi_configure_news_radar', desc: 'Set Autopilot mode, Google News topic keywords, language, & custom RSS' },
      { name: 'redaksi_scan_breaking_news', desc: 'Trigger live RSS scan + AI Chief Editor story clustering & viral pitch' },
      { name: 'redaksi_list_ideas', desc: 'List pending/converted/rejected story ideas from AI Radar & Telegram' },
      { name: 'redaksi_manage_idea', desc: 'Create idea, convert idea to Carousel job, reject, or restore' },
    ],
  },
  {
    domain: '3. Carousel Creation Engine (4 Tools)',
    tools: [
      { name: 'redaksi_list_templates', desc: 'List all carousel templates and their slide UI schemas' },
      { name: 'redaksi_generate_from_topic', desc: 'Autonomous 5W1H research + opinion + slide writer + parallel AI images' },
      { name: 'redaksi_create_from_script', desc: 'Verbatim Slide 1..N script-to-carousel + parallel AI images & PNG render' },
      { name: 'redaksi_create_manual_post', desc: 'Queue pre-rendered images with caption & optional schedule' },
    ],
  },
  {
    domain: '4. Granular Slide Studio & Per-Slide AI Image Regen (4 Tools)',
    tools: [
      { name: 'redaksi_get_post', desc: 'Inspect post slides, prompts, research insights, caption, & rendered PNGs' },
      { name: 'redaksi_update_post', desc: 'Edit cover or specific slides by index, add/remove slides, & re-render PNGs' },
      { name: 'redaksi_generate_slide_image', desc: 'Regenerate AI image for cover, 1 slide, multiple slides, or all + auto-prompt' },
      { name: 'redaksi_regenerate_post', desc: 'Run tier: "media" (0 tokens), "content", or full "pipeline" regeneration' },
    ],
  },
  {
    domain: '5. Queue Scheduler, Publishing & Worker Control (4 Tools)',
    tools: [
      { name: 'redaksi_list_queue', desc: 'List pending, scheduled, draft, buffering, published, or error posts' },
      { name: 'redaksi_manage_queue_item', desc: 'Schedule, clear schedule, move/reorder, switch draft/pending, duplicate, delete' },
      { name: 'redaksi_publish_post', desc: 'Publish immediately to Buffer/IG, check slot conflicts, or retry failed post' },
      { name: 'redaksi_manage_worker_jobs', desc: 'Monitor active background worker jobs, retry failed jobs, or dismiss errors' },
    ],
  },
]

const closeModal = () => {
  emit('update:modelValue', false)
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="props.modelValue"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-3 sm:p-6"
      @click.self="closeModal"
    >
      <div class="bg-default border border-default rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        <!-- Modal Header -->
        <div class="px-5 py-4 border-b border-default flex items-center justify-between bg-elevated">
          <div class="flex items-center gap-3">
            <div class="p-2 rounded-xl bg-primary/15 text-primary border border-primary/30">
              <Bot class="w-5 h-5" />
            </div>
            <div>
              <h2 class="text-base sm:text-lg font-bold text-default flex items-center gap-2">
                Connect Redaksi.AI MCP to Your AI Agent
                <span class="px-2 py-0.5 text-[10px] font-bold uppercase rounded-full bg-emerald-500/15 text-emerald-500 border border-emerald-500/30">
                  23 Tools Ready
                </span>
              </h2>
              <p class="text-xs text-muted">
                Control all accounts, News Radar, slide prompts, and Instagram publishing directly from OMP, Claude, or Cursor.
              </p>
            </div>
          </div>

          <button
            type="button"
            @click="closeModal"
            class="p-1.5 rounded-full text-muted hover:text-default hover:bg-muted cursor-pointer transition"
          >
            <X class="w-5 h-5" />
          </button>
        </div>

        <!-- Mode Tabs -->
        <div class="px-5 pt-3 border-b border-default bg-default flex items-center justify-between gap-2 flex-wrap">
          <div class="flex items-center gap-1">
            <button
              type="button"
              @click="activeTab = 'prompt'"
              class="px-3.5 py-2 text-xs font-semibold border-b-2 transition cursor-pointer flex items-center gap-1.5"
              :class="activeTab === 'prompt' ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-default'"
            >
              <Sparkles class="w-3.5 h-3.5" />
              1-Click AI Auto-Setup Prompt
            </button>
            <button
              type="button"
              @click="activeTab = 'json'"
              class="px-3.5 py-2 text-xs font-semibold border-b-2 transition cursor-pointer flex items-center gap-1.5"
              :class="activeTab === 'json' ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-default'"
            >
              <Terminal class="w-3.5 h-3.5" />
              Manual mcp.json
            </button>
            <button
              type="button"
              @click="activeTab = 'tools'"
              class="px-3.5 py-2 text-xs font-semibold border-b-2 transition cursor-pointer flex items-center gap-1.5"
              :class="activeTab === 'tools' ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-default'"
            >
              <Layers class="w-3.5 h-3.5" />
              23 Tools Catalog
            </button>
          </div>

          <!-- Show/Hide API Key Toggle -->
          <button
            type="button"
            @click="showApiKey = !showApiKey"
            class="mb-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium border border-default bg-muted text-muted hover:text-default cursor-pointer"
          >
            <EyeOff v-if="showApiKey" class="w-3.5 h-3.5" />
            <Eye v-else class="w-3.5 h-3.5" />
            {{ showApiKey ? 'Hide API Key' : 'Preview Real API Key' }}
          </button>
        </div>

        <!-- Modal Body -->
        <div class="p-5 overflow-y-auto flex-1 space-y-5">
          <!-- TAB 1: 1-CLICK AI AGENT AUTO-SETUP PROMPT -->
          <template v-if="activeTab === 'prompt'">
            <div class="p-3.5 rounded-xl bg-primary/8 border border-primary/25 text-xs text-default space-y-1">
              <p class="font-semibold text-primary flex items-center gap-1.5">
                <Sparkles class="w-4 h-4" />
                Zero-Clone Automatic Setup:
              </p>
              <p class="text-muted leading-relaxed">
                Just copy the prompt below and paste it into your AI Coding Agent (OMP, Claude Code, Cursor, or Windsurf). Your agent will automatically download the lightweight MCP bridge script from this server, configure <code>mcp.json</code> with your API key, and verify the connection!
              </p>
            </div>

            <!-- Select Target Agent -->
            <div>
              <label class="block text-xs font-semibold text-default mb-2">Select Your AI Agent:</label>
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <button
                  v-for="ag in agentTargets"
                  :key="ag.id"
                  type="button"
                  @click="selectedAgent = ag.id"
                  class="px-3 py-2 rounded-lg border text-xs font-semibold text-left transition cursor-pointer"
                  :class="
                    selectedAgent === ag.id
                      ? 'border-primary bg-primary/12 text-primary ring-1 ring-primary/30'
                      : 'border-default bg-default text-muted hover:text-default hover:bg-muted'
                  "
                >
                  <div class="flex items-center gap-1.5">
                    <Cpu class="w-3.5 h-3.5 shrink-0" />
                    <span class="truncate">{{ ag.label }}</span>
                  </div>
                  <div class="text-[10px] font-mono opacity-75 truncate mt-0.5">{{ ag.configPath }}</div>
                </button>
              </div>
            </div>

            <!-- Prompt Preview Box -->
            <div class="relative">
              <div class="flex items-center justify-between mb-1.5">
                <span class="text-xs font-semibold text-default">Prompt to Paste into Your AI Agent:</span>
                <button
                  type="button"
                  @click="copyText(buildAutoSetupPrompt(true), 'prompt', 'AI Auto-Setup Prompt')"
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-inverted hover:bg-primary/90 shadow-xs cursor-pointer transition"
                >
                  <Check v-if="copiedKey === 'prompt'" class="w-3.5 h-3.5" />
                  <Copy v-else class="w-3.5 h-3.5" />
                  {{ copiedKey === 'prompt' ? 'Copied with Live API Key!' : 'Copy Prompt for AI Agent' }}
                </button>
              </div>
              <pre class="p-4 rounded-xl bg-muted border border-default text-xs font-mono text-default whitespace-pre-wrap overflow-x-auto max-h-72 leading-relaxed select-all">{{ displayedPrompt }}</pre>
            </div>
          </template>

          <!-- TAB 2: MANUAL MCP.JSON CONFIG -->
          <template v-else-if="activeTab === 'json'">
            <div class="space-y-4">
              <div>
                <div class="flex items-center justify-between mb-1.5">
                  <span class="text-xs font-semibold text-default">Step 1 — Download Zero-Dependency Bridge Script:</span>
                  <button
                    type="button"
                    @click="copyText(`mkdir -p ~/.redaksi-ai && curl -fsSL ${apiUrl}/mcp-bridge.mjs -o ~/.redaksi-ai/mcp-bridge.mjs`, 'curl', 'Download Command')"
                    class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-elevated border border-default hover:bg-muted text-default cursor-pointer"
                  >
                    <Check v-if="copiedKey === 'curl'" class="w-3.5 h-3.5 text-emerald-500" />
                    <Copy v-else class="w-3.5 h-3.5" />
                    Copy Command
                  </button>
                </div>
                <pre class="p-3 rounded-lg bg-muted border border-default text-xs font-mono text-default overflow-x-auto">mkdir -p ~/.redaksi-ai &amp;&amp; curl -fsSL {{ apiUrl }}/mcp-bridge.mjs -o ~/.redaksi-ai/mcp-bridge.mjs</pre>
              </div>

              <div>
                <div class="flex items-center justify-between mb-1.5">
                  <span class="text-xs font-semibold text-default">Step 2 — Add to your <code>mcp.json</code>:</span>
                  <button
                    type="button"
                    @click="copyText(buildManualJson(true), 'json', 'mcp.json Snippet')"
                    class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-inverted hover:bg-primary/90 cursor-pointer"
                  >
                    <Check v-if="copiedKey === 'json'" class="w-3.5 h-3.5" />
                    <Copy v-else class="w-3.5 h-3.5" />
                    {{ copiedKey === 'json' ? 'Copied JSON!' : 'Copy mcp.json Config' }}
                  </button>
                </div>
                <pre class="p-4 rounded-xl bg-muted border border-default text-xs font-mono text-default overflow-x-auto leading-relaxed">{{ displayedManualJson }}</pre>
              </div>
            </div>
          </template>

          <!-- TAB 3: 23 TOOLS CATALOG -->
          <template v-else>
            <div class="space-y-4">
              <div v-for="grp in toolGroups" :key="grp.domain" class="border border-default rounded-xl overflow-hidden">
                <div class="px-4 py-2.5 bg-elevated border-b border-default text-xs font-bold text-default">
                  {{ grp.domain }}
                </div>
                <div class="divide-y divide-default">
                  <div
                    v-for="t in grp.tools"
                    :key="t.name"
                    class="px-4 py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs bg-default"
                  >
                    <code class="font-mono font-semibold text-primary shrink-0">{{ t.name }}</code>
                    <span class="text-muted sm:text-right">{{ t.desc }}</span>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- Modal Footer -->
        <div class="px-5 py-3.5 border-t border-default bg-elevated flex items-center justify-between gap-3">
          <span class="text-xs text-muted truncate">
            Server Endpoint: <code class="font-mono text-default">{{ apiUrl }}</code>
          </span>
          <div class="flex items-center gap-2 shrink-0">
            <button
              v-if="activeTab === 'prompt'"
              type="button"
              @click="copyText(buildAutoSetupPrompt(true), 'prompt', 'AI Auto-Setup Prompt')"
              class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-primary text-inverted hover:bg-primary/90 cursor-pointer transition"
            >
              <Check v-if="copiedKey === 'prompt'" class="w-4 h-4" />
              <Copy v-else class="w-4 h-4" />
              {{ copiedKey === 'prompt' ? 'Copied!' : 'Copy Auto-Setup Prompt' }}
            </button>
            <button
              type="button"
              @click="closeModal"
              class="px-4 py-2 rounded-lg text-xs font-medium border border-default bg-default text-default hover:bg-muted cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
