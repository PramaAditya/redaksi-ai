<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { apiFetch } from '../auth';
import { useConnectionStore } from '../store';

const connectionStore = useConnectionStore();

const ideas = ref<any[]>([]);
const templates = ref<any[]>([]);
const selectedTemplates = ref<Record<number, string>>({});
const currentTab = ref('pending');

const tabItems = [
  { label: 'Pending', icon: 'i-lucide-clock', slot: 'content', value: 'pending' },
  { label: 'Converted', icon: 'i-lucide-check-circle', slot: 'content', value: 'converted' },
  { label: 'Rejected', icon: 'i-lucide-x-circle', slot: 'content', value: 'rejected' }
];

const onTabChange = (value: number | string) => {
  currentTab.value = value as string;
  fetchIdeas();
};

const loading = ref(false);

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
    
    ideas.value.forEach(idea => {
      const available = getAvailableTemplatesForIdea(idea);
      if (!selectedTemplates.value[idea.id] && available.length > 0) {
        selectedTemplates.value[idea.id] = available[0].id;
      }
    });
  } catch (error) {
    console.error('Failed to fetch ideas:', error);
  } finally {
    loading.value = false;
  }
};

watch(() => connectionStore.activeConnectionId, () => {
  fetchIdeas();
}, { immediate: true });

onMounted(async () => {
  await fetchTemplates();
});

const getAvailableTemplatesForIdea = (_idea: any) => {
  return templates.value;
};

const convertIdea = async (ideaId: number) => {
  const idea = ideas.value.find(i => i.id === ideaId);
  const available = idea ? getAvailableTemplatesForIdea(idea) : templates.value;
  const defaultFallback = available[0]?.id || 'image:poros.perjuangan:carousel_dark';

  const templateId = selectedTemplates.value[ideaId] || defaultFallback;
  try {
    await apiFetch(`/api/ideas/${ideaId}/convert`, {
      method: 'POST',
      body: JSON.stringify({ templateId })
    });
    fetchIdeas();
  } catch (error) {
    console.error('Failed to convert idea:', error);
    alert('Failed to convert idea');
  }
};

const updateStatus = async (ideaId: number, status: string) => {
  try {
    await apiFetch(`/api/ideas/${ideaId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status })
    });
    fetchIdeas();
  } catch (error) {
    console.error(`Failed to mark idea as ${status}:`, error);
    alert(`Failed to update status`);
  }
};

const formatDate = (dateStr: string) => {
  return new Date(dateStr).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
};
</script>

<template>
  <div>
    <div class="sm:flex sm:items-center sm:justify-between mb-8">
      <div>
        <h1 class="text-2xl font-bold text-default">Ideas</h1>
        <p class="mt-2 text-sm text-muted">Manage ideas submitted via Telegram.</p>
      </div>
    </div>

    <div v-if="!connectionStore.activeConnectionId" class="text-center py-10 bg-default border border-default rounded-lg text-muted">
         Please select or create a connection from the sidebar.
    </div>

    <!-- Tabs -->
    <UTabs 
      v-else
      v-model="currentTab"
      :items="tabItems" 
      class="w-full mb-6"
      @update:modelValue="onTabChange"
    >
      <template #content="{ item: _item }">
        <div v-if="loading" class="text-center py-10">
          <p class="text-muted">Loading ideas...</p>
        </div>
        <div v-else-if="ideas.length === 0" class="text-center py-10">
          <p class="text-muted">No ideas found for this status.</p>
        </div>
        <div v-else class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="idea in ideas" :key="idea.id" class="bg-default overflow-hidden shadow rounded-lg border border-default flex flex-col">
            <div class="p-5 flex-1">
              <p class="text-xs text-muted mb-2">{{ formatDate(idea.createdAt) }}</p>
              <p class="text-sm text-default line-clamp-4">{{ idea.text }}</p>
              
              <div v-if="idea.media && idea.media.length > 0" class="mt-3 flex gap-2 overflow-x-auto">
                <template v-for="(m, i) in idea.media" :key="i">
                  <img :src="m.url" class="h-16 w-16 object-cover rounded" />
                </template>
              </div>
            </div>
            
            <div class="bg-elevated px-5 py-3 border-t border-default flex flex-col gap-3">
              <div v-if="idea.status === 'pending' || idea.status === 'rejected'" class="flex flex-col gap-2">
                <label class="block text-xs font-medium text-default">Template</label>
                <select v-model="selectedTemplates[idea.id]" class="mt-1 block w-full pl-3 pr-10 py-2 text-sm border-default bg-default text-default focus:outline-none focus:ring-primary focus:border-primary sm:text-sm rounded-md">
                  <option v-for="t in getAvailableTemplatesForIdea(idea)" :key="t.id" :value="t.id">{{ t.name }}</option>
                </select>
              </div>
              <div class="flex gap-2">
                <button 
                  v-if="idea.status === 'pending' || idea.status === 'rejected'" 
                  @click="convertIdea(idea.id)" 
                  class="flex-1 inline-flex justify-center items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded shadow-sm text-white bg-primary hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary"
                >
                  Convert to Post
                </button>
                
                <button 
                  v-if="idea.status === 'pending'" 
                  @click="updateStatus(idea.id, 'rejected')" 
                  class="flex-1 inline-flex justify-center items-center px-3 py-1.5 border border-default shadow-sm text-xs font-medium rounded text-default bg-default hover:bg-muted focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary"
                >
                  Reject
                </button>
                
                 <button 
                  v-if="idea.status === 'rejected'" 
                  @click="updateStatus(idea.id, 'pending')" 
                  class="flex-1 inline-flex justify-center items-center px-3 py-1.5 border border-default shadow-sm text-xs font-medium rounded text-default bg-default hover:bg-muted focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary"
                >
                  Move to Pending
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </UTabs>
  </div>
</template>