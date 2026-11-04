<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Radar, Sparkles, ExternalLink, Loader2, Settings2, CheckCircle2, XCircle, RotateCcw, Send } from 'lucide-vue-next';
import { apiFetch } from '../auth';
import { useConnectionStore } from '../store';

const toast = useToast();
const router = useRouter();
const connectionStore = useConnectionStore();

const ideas = ref<any[]>([]);
const templates = ref<any[]>([]);
const selectedTemplates = ref<Record<number, string>>({});
const selectedHeroStyles = ref<Record<number, string>>({});
const currentTab = ref('pending');
const sourceFilter = ref<'all' | 'radar' | 'telegram'>('all');
const scanningNews = ref(false);
const convertingId = ref<number | null>(null);

const tabItems = [
  { label: 'Pending Review', icon: 'i-lucide-clock', slot: 'content', value: 'pending' },
  { label: 'Converted', icon: 'i-lucide-check-circle', slot: 'content', value: 'converted' },
  { label: 'Rejected', icon: 'i-lucide-x-circle', slot: 'content', value: 'rejected' }
];

const onTabChange = (value: number | string) => {
  currentTab.value = value as string;
  fetchIdeas();
};

const loading = ref(false);

const isRadarIdea = (idea: any): boolean => {
  return idea?.metadata?.sourceType === 'radar' || idea?.chatId === 'NEWS_RADAR';
};

const filteredIdeas = computed(() => {
  if (sourceFilter.value === 'all') return ideas.value;
  if (sourceFilter.value === 'radar') return ideas.value.filter((i) => isRadarIdea(i));
  return ideas.value.filter((i) => !isRadarIdea(i));
});

const radarCount = computed(() => ideas.value.filter((i) => isRadarIdea(i)).length);
const telegramCount = computed(() => ideas.value.filter((i) => !isRadarIdea(i)).length);

const fetchTemplates = async () => {
  try {
    const data = await apiFetch('/api/templates');
    templates.value = data || [];
  } catch (error) {
    console.error('Failed to fetch templates:', error);
  }
};

const fetchIdeas = async () => {
  loading.value = true;
  try {
    let url = `/api/ideas?status=${currentTab.value}`;
    if (connectionStore.activeConnectionId) {
      url += `&connectionId=${connectionStore.activeConnectionId}`;
    }
    const data = await apiFetch(url);
    ideas.value = data || [];

    const activeConn = connectionStore.connections.find((c: any) => c.id === connectionStore.activeConnectionId);
    const isGeopolitik = activeConn?.name?.toLowerCase().includes('geopolitik');

    ideas.value.forEach((idea) => {
      const available = getAvailableTemplatesForIdea(idea);
      if (!selectedTemplates.value[idea.id] && available.length > 0) {
        const preferred = isGeopolitik
          ? available.find((t: any) => t.id.includes('aa.geopolitik'))
          : available[0];
        selectedTemplates.value[idea.id] = preferred ? preferred.id : available[0].id;
      }
      if (!selectedHeroStyles.value[idea.id]) {
        selectedHeroStyles.value[idea.id] = 'Dark-Dramatize';
      }
    });
  } catch (error) {
    console.error('Failed to fetch ideas:', error);
  } finally {
    loading.value = false;
  }
};

const scanBreakingNews = async () => {
  if (!connectionStore.activeConnectionId) return;
  scanningNews.value = true;
  try {
    const res = await apiFetch('/api/ideas/scan-news', {
      method: 'POST',
      body: JSON.stringify({
        connectionId: connectionStore.activeConnectionId,
      }),
    });

    const count = res.insertedIdeas?.length || 0;
    if (count > 0) {
      toast.add({
        title: `📡 Found ${count} Viral Story Cluster(s)!`,
        description: res.autoQueuedJob
          ? `Top story was also auto-queued into Worker Job #${res.autoQueuedJob.id}.`
          : `Curated from ${res.scannedCount || 0} latest RSS articles.`,
        color: 'success',
      });
      currentTab.value = 'pending';
      await fetchIdeas();
    } else {
      toast.add({
        title: 'No New Untouched Stories Found',
        description: res.message || `Scanned ${res.scannedCount || 0} RSS items; all relevant topics were already covered.`,
        color: 'info',
      });
    }
  } catch (error: any) {
    toast.add({
      title: 'News Radar Scan Failed',
      description: error.message || String(error),
      color: 'error',
    });
  } finally {
    scanningNews.value = false;
  }
};

watch(
  () => connectionStore.activeConnectionId,
  () => {
    fetchIdeas();
  },
  { immediate: true }
);

onMounted(async () => {
  await fetchTemplates();
});

const getAvailableTemplatesForIdea = (_idea: any) => {
  return templates.value;
};

const convertIdea = async (ideaId: number) => {
  const idea = ideas.value.find((i) => i.id === ideaId);
  const available = idea ? getAvailableTemplatesForIdea(idea) : templates.value;
  const defaultFallback = available[0]?.id || 'image:poros.perjuangan:carousel_dark';

  const templateId = selectedTemplates.value[ideaId] || defaultFallback;
  const heroStyle = selectedHeroStyles.value[ideaId] || 'Dark-Dramatize';
  convertingId.value = ideaId;
  try {
    await apiFetch(`/api/ideas/${ideaId}/convert`, {
      method: 'POST',
      body: JSON.stringify({ templateId, heroStyle }),
    });
    toast.add({
      title: '🚀 Carousel Job Enqueued!',
      description: 'Worker is researching and rendering your carousel.',
      color: 'success',
    });
    await fetchIdeas();
  } catch (error: any) {
    toast.add({
      title: 'Failed to convert idea',
      description: error.message || String(error),
      color: 'error',
    });
  } finally {
    convertingId.value = null;
  }
};

const updateStatus = async (ideaId: number, status: string) => {
  try {
    await apiFetch(`/api/ideas/${ideaId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
    fetchIdeas();
  } catch (error) {
    console.error(`Failed to mark idea as ${status}:`, error);
  }
};

const formatDate = (dateStr: string) => {
  return new Date(dateStr).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};
</script>

<template>
  <div>
    <!-- Top Header & Radar Actions -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
      <div>
        <h1 class="text-2xl font-bold text-default flex items-center gap-2.5">
          <Radar class="w-6 h-6 text-primary" />
          Newsroom Radar & Ideas
        </h1>
        <p class="mt-1 text-sm text-muted">
          AI-curated multi-source breaking news clusters & Telegram story submissions.
        </p>
      </div>

      <div v-if="connectionStore.activeConnectionId" class="flex items-center gap-2.5">
        <router-link
          to="/settings"
          class="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-default bg-default text-default hover:bg-muted transition"
        >
          <Settings2 class="w-4 h-4 text-muted" />
          Radar Config
        </router-link>

        <button
          type="button"
          @click="scanBreakingNews"
          :disabled="scanningNews"
          class="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-primary text-inverted hover:bg-primary/90 disabled:opacity-50 shadow-sm cursor-pointer transition"
        >
          <Loader2 v-if="scanningNews" class="w-4 h-4 animate-spin" />
          <Radar v-else class="w-4 h-4" />
          {{ scanningNews ? 'Scanning RSS & Ranking via AI...' : 'Scan Breaking News' }}
        </button>
      </div>
    </div>

    <div
      v-if="!connectionStore.activeConnectionId"
      class="text-center py-10 bg-default border border-default rounded-lg text-muted"
    >
      Please select or create a connection from the sidebar.
    </div>

    <!-- Status Tabs + Source Filter Pills -->
    <template v-else>
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <UTabs
          v-model="currentTab"
          :items="tabItems"
          class="w-full sm:w-auto"
          @update:modelValue="onTabChange"
        />

        <div class="inline-flex items-center gap-1 bg-muted p-1 rounded-lg border border-default self-start sm:self-auto text-xs font-medium">
          <button
            type="button"
            @click="sourceFilter = 'all'"
            class="px-3 py-1 rounded-md transition cursor-pointer"
            :class="sourceFilter === 'all' ? 'bg-default text-default shadow-xs' : 'text-muted hover:text-default'"
          >
            All ({{ ideas.length }})
          </button>
          <button
            type="button"
            @click="sourceFilter = 'radar'"
            class="px-3 py-1 rounded-md flex items-center gap-1 transition cursor-pointer"
            :class="sourceFilter === 'radar' ? 'bg-default text-primary shadow-xs' : 'text-muted hover:text-default'"
          >
            📡 AI Radar ({{ radarCount }})
          </button>
          <button
            type="button"
            @click="sourceFilter = 'telegram'"
            class="px-3 py-1 rounded-md flex items-center gap-1 transition cursor-pointer"
            :class="sourceFilter === 'telegram' ? 'bg-default text-default shadow-xs' : 'text-muted hover:text-default'"
          >
            📱 Telegram ({{ telegramCount }})
          </button>
        </div>
      </div>

      <div v-if="loading" class="text-center py-12">
        <Loader2 class="w-7 h-7 text-primary animate-spin mx-auto mb-2" />
        <p class="text-sm text-muted">Loading newsroom desk...</p>
      </div>

      <div
        v-else-if="filteredIdeas.length === 0"
        class="text-center py-12 bg-default border border-default rounded-xl p-6 space-y-3"
      >
        <Radar class="w-10 h-10 text-muted mx-auto opacity-50" />
        <p class="text-sm font-medium text-default">No story candidates in this view yet.</p>
        <p class="text-xs text-muted max-w-md mx-auto">
          Click <strong>Scan Breaking News</strong> above to fetch the latest RSS articles, deduplicate against your past posts, and let the AI Chief Editor pitch the top viral stories.
        </p>
        <button
          v-if="currentTab === 'pending'"
          type="button"
          @click="scanBreakingNews"
          :disabled="scanningNews"
          class="mt-2 inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-primary text-inverted hover:bg-primary/90 disabled:opacity-50 cursor-pointer"
        >
          <Loader2 v-if="scanningNews" class="w-4 h-4 animate-spin" />
          <Sparkles v-else class="w-4 h-4" />
          {{ scanningNews ? 'Scanning...' : 'Scan Breaking News Now' }}
        </button>
      </div>

      <!-- Story Cards Grid -->
      <div v-else class="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div
          v-for="idea in filteredIdeas"
          :key="idea.id"
          class="bg-default overflow-hidden shadow-sm rounded-xl border flex flex-col transition"
          :class="isRadarIdea(idea) ? 'border-primary/35 ring-1 ring-primary/10' : 'border-default'"
        >
          <div class="p-5 flex-1 space-y-3">
            <!-- Badge & Timestamp Header -->
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <span
                  v-if="isRadarIdea(idea)"
                  class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-primary/15 text-primary border border-primary/30"
                >
                  📡 AI RADAR {{ idea.metadata?.rank ? `· Top Pick #${idea.metadata.rank}` : '' }}
                </span>
                <span
                  v-else
                  class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-muted text-default border border-default"
                >
                  📱 TELEGRAM
                </span>
              </div>
              <span class="text-xs text-muted">{{ formatDate(idea.createdAt) }}</span>
            </div>

            <!-- AI Radar Structured Card -->
            <template v-if="isRadarIdea(idea)">
              <h3 class="text-base font-bold text-default leading-snug">
                {{ idea.metadata?.headline || idea.text.split('\n')[0] }}
              </h3>

              <!-- AI Chief Editor Pitch -->
              <div
                v-if="idea.metadata?.pitch"
                class="p-3 rounded-lg bg-amber-500/8 border border-amber-500/25 text-xs text-default space-y-1"
              >
                <div class="font-semibold text-amber-500 flex items-center gap-1.5">
                  <Sparkles class="w-3.5 h-3.5" />
                  AI Chief Editor Pitch:
                </div>
                <p class="text-muted leading-relaxed">{{ idea.metadata.pitch }}</p>
              </div>

              <!-- Multi-Source Cluster Chips -->
              <div v-if="idea.metadata?.sources?.length" class="space-y-1.5 pt-1">
                <span class="block text-[11px] font-semibold text-muted uppercase tracking-wider">
                  {{ idea.metadata.sources.length }} Corroborated Source(s):
                </span>
                <div class="flex flex-wrap gap-1.5">
                  <a
                    v-for="(src, sIdx) in idea.metadata.sources"
                    :key="sIdx"
                    :href="src.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-elevated hover:bg-muted text-default border border-default transition"
                    :title="src.title || src.url"
                  >
                    <ExternalLink class="w-3 h-3 text-primary shrink-0" />
                    <span class="truncate max-w-[180px]">{{ src.domain || 'source' }}</span>
                  </a>
                </div>
              </div>
            </template>

            <!-- Standard Telegram Idea Card -->
            <template v-else>
              <p class="text-sm text-default whitespace-pre-wrap line-clamp-5">{{ idea.text }}</p>
              <div v-if="idea.media && idea.media.length > 0" class="mt-3 flex gap-2 overflow-x-auto">
                <template v-for="(m, i) in idea.media" :key="i">
                  <img :src="m.url" class="h-16 w-16 object-cover rounded border border-default" />
                </template>
              </div>
            </template>
          </div>

          <!-- Card Footer: Template + Hero Style + Convert / Reject -->
          <div class="bg-elevated px-5 py-3.5 border-t border-default space-y-3">
            <div
              v-if="idea.status === 'pending' || idea.status === 'rejected'"
              class="grid grid-cols-1 sm:grid-cols-2 gap-2.5"
            >
              <div>
                <label class="block text-[11px] font-semibold text-muted mb-1">Template</label>
                <select
                  v-model="selectedTemplates[idea.id]"
                  class="block w-full px-2.5 py-1.5 text-xs border border-default bg-default text-default rounded-md"
                >
                  <option v-for="t in getAvailableTemplatesForIdea(idea)" :key="t.id" :value="t.id">
                    {{ t.name }}
                  </option>
                </select>
              </div>
              <div>
                <label class="block text-[11px] font-semibold text-muted mb-1">Cover Visual Style</label>
                <select
                  v-model="selectedHeroStyles[idea.id]"
                  class="block w-full px-2.5 py-1.5 text-xs border border-default bg-default text-default rounded-md"
                >
                  <option value="Dark-Dramatize">🌑 Dark Dramatize (Chiaroscuro)</option>
                  <option value="4K-Enhance">🌟 4K Realistic Photo</option>
                </select>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <button
                v-if="idea.status === 'pending' || idea.status === 'rejected'"
                type="button"
                @click="convertIdea(idea.id)"
                :disabled="convertingId === idea.id"
                class="flex-1 inline-flex justify-center items-center gap-1.5 px-3 py-2 border border-transparent text-xs font-semibold rounded-lg shadow-xs text-inverted bg-primary hover:bg-primary/90 disabled:opacity-50 cursor-pointer transition"
              >
                <Loader2 v-if="convertingId === idea.id" class="w-3.5 h-3.5 animate-spin" />
                <Send v-else class="w-3.5 h-3.5" />
                {{ convertingId === idea.id ? 'Queueing...' : 'Generate Carousel' }}
              </button>

              <button
                v-if="idea.status === 'pending'"
                type="button"
                @click="updateStatus(idea.id, 'rejected')"
                class="inline-flex justify-center items-center gap-1 px-3 py-2 border border-default text-xs font-medium rounded-lg text-muted hover:text-error hover:border-error/40 bg-default cursor-pointer transition"
              >
                <XCircle class="w-3.5 h-3.5" />
                Reject
              </button>

              <button
                v-if="idea.status === 'rejected'"
                type="button"
                @click="updateStatus(idea.id, 'pending')"
                class="inline-flex justify-center items-center gap-1 px-3 py-2 border border-default text-xs font-medium rounded-lg text-default bg-default hover:bg-muted cursor-pointer transition"
              >
                <RotateCcw class="w-3.5 h-3.5" />
                Restore
              </button>

              <button
                v-if="idea.status === 'converted'"
                type="button"
                @click="router.push('/')"
                class="w-full inline-flex justify-center items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-500/10 text-emerald-500 border border-emerald-500/30 cursor-pointer"
              >
                <CheckCircle2 class="w-3.5 h-3.5" />
                Converted — View in Queue Dashboard &rarr;
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>