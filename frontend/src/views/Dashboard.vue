<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import { Edit, Send, GripVertical, RotateCcw, MoreVertical, Copy, Loader2, ExternalLink, Sparkles, AlertCircle, X } from "lucide-vue-next";
import { getAuthHeaders, setPassword } from "../auth";
import { Fancybox } from "@fancyapps/ui";
import draggable from "vuedraggable";
import { useConnectionStore } from '../store';

const connectionStore = useConnectionStore();
const toast = useToast();

const queue = ref<any[]>([]);
const scheduledQueue = ref<any[]>([]);
const postingSlots = ref<{day: string, time: string}[]>([]);
const loading = ref(true);
const error = ref("");
const activeTab = ref('pending');
const activeJobs = ref<any[]>([]);
const retryingJobId = ref<number | null>(null);
let jobsPollTimer: any = null;
let trackedInFlightJobIds = new Set<number>();
const isScheduleModalOpen = ref(false);
const scheduleModalItemId = ref<number | null>(null);
const scheduleModalDate = ref("");

const openScheduleModal = (item: any) => {
  scheduleModalItemId.value = item.id;
  if (item.scheduledAt) {
     const date = new Date(item.scheduledAt);
     // Format for datetime-local input: YYYY-MM-DDThh:mm
     date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
     scheduleModalDate.value = date.toISOString().slice(0, 16);
  } else {
     scheduleModalDate.value = "";
  }
  isScheduleModalOpen.value = true;
};

// @ts-ignore
const saveSchedule = async () => {
  if (!scheduleModalItemId.value) return;
  
  try {
    const res = await fetch(`/api/queue/${scheduleModalItemId.value}`, {
      method: "PUT",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ scheduledAt: scheduleModalDate.value || null }),
    });
    if (res.status === 401) {
      toast.add({ title: "Unauthorized", color: "error" });
      return;
    }
    if (!res.ok) throw new Error("Failed to save schedule");
    
    toast.add({ title: "Schedule updated", color: "success" });
    isScheduleModalOpen.value = false;
    fetchQueue();
  } catch (err: any) {
    toast.add({ title: err.message, color: "error" });
  }
};

const clearSchedule = async (id: number) => {
   try {
    const res = await fetch(`/api/queue/${id}`, {
      method: "PUT",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ scheduledAt: null }),
    });
    if (res.status === 401) {
      toast.add({ title: "Unauthorized", color: "error" });
      return;
    }
    if (!res.ok) throw new Error("Failed to clear schedule");
    
    toast.add({ title: "Schedule cleared", color: "success" });
    fetchQueue();
  } catch (err: any) {
    toast.add({ title: err.message, color: "error" });
  }
};

const tabItems = [
  { label: 'Pending', icon: 'i-lucide-clock', slot: 'content', value: 'pending' },
  { label: 'Draft', icon: 'i-lucide-file-text', slot: 'content', value: 'draft' },
  { label: 'Published', icon: 'i-lucide-check-circle', slot: 'content', value: 'published' },
  { label: 'Error', icon: 'i-lucide-alert-circle', slot: 'content', value: 'error' }
];

const onTabChange = (value: number | string) => {
  activeTab.value = value as string;
  fetchQueue();
};

const openLightbox = (mediaArray: any[], index: number) => {
  const items = mediaArray.map((m) => ({
    src: m.url,
    type: "image",
  }));
  Fancybox.show(items, { startIndex: index });
};

const dayMap: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
};

const getNextSlot = (fromDate: Date, sortedSlots: {day: string, time: string}[]) => {
  if (!sortedSlots.length) return null;

  const currentDay = fromDate.getDay();
  const currentHour = fromDate.getHours();
  const currentMinute = fromDate.getMinutes();

  for (let i = 0; i < 7; i++) {
    const searchDay = (currentDay + i) % 7;
    const slotsForDay = sortedSlots.filter(s => dayMap[s.day.toLowerCase()] === searchDay);
    
    for (const slot of slotsForDay) {
      const [h, m] = slot.time.split(':').map(Number);
      if (i === 0) {
        if (h > currentHour || (h === currentHour && m > currentMinute)) {
          const nextDate = new Date(fromDate);
          nextDate.setDate(nextDate.getDate() + i);
          nextDate.setHours(h, m, 0, 0);
          return nextDate;
        }
      } else {
        const nextDate = new Date(fromDate);
        nextDate.setDate(nextDate.getDate() + i);
        nextDate.setHours(h, m, 0, 0);
        return nextDate;
      }
    }
  }
  
  const firstSlot = sortedSlots[0];
  const [h, m] = firstSlot.time.split(':').map(Number);
  const targetDay = dayMap[firstSlot.day.toLowerCase()];
  let daysToAdd = targetDay - currentDay;
  if (daysToAdd <= 0) daysToAdd += 7;
  
  const nextDate = new Date(fromDate);
  nextDate.setDate(nextDate.getDate() + daysToAdd);
  nextDate.setHours(h, m, 0, 0);
  return nextDate;
};

const calculateExpectedTimes = () => {
  if (!queue.value.length) return;

  const sortedSlots = [...postingSlots.value].sort((a, b) => {
    const dayA = dayMap[a.day.toLowerCase()] || 0;
    const dayB = dayMap[b.day.toLowerCase()] || 0;
    if (dayA !== dayB) return dayA - dayB;
    return a.time.localeCompare(b.time);
  });

  let refDate = new Date();
  
  for (const item of queue.value) {
    if (!sortedSlots.length) {
      item.expectedPostAt = null;
      continue;
    }

    const next = getNextSlot(refDate, sortedSlots);
    if (next) {
      item.expectedPostAt = next;
      refDate = new Date(next.getTime() + 60000);
    } else {
      item.expectedPostAt = null;
    }
  }
};

const fetchSettings = async () => {
  try {
    const res = await fetch("/api/connections", { headers: getAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      const activeConn = data.find((c: any) => c.id === connectionStore.activeConnectionId);
      if (activeConn) {
         postingSlots.value = activeConn.postingSlots || [];
         calculateExpectedTimes();
      }
    }
  } catch (e) {}
};

const fetchQueue = async (silent = false) => {
  if (!silent) loading.value = true;
  try {
    let url = `/api/queue?status=${activeTab.value}`;
    if (connectionStore.activeConnectionId) {
       url += `&connectionId=${connectionStore.activeConnectionId}`;
    }
    const res = await fetch(url, { headers: getAuthHeaders() });
    if (res.status === 401) {
      const pwd = prompt("Enter Dashboard Password:");
      if (pwd !== null) {
        setPassword(pwd);
        return fetchQueue();
      }
      throw new Error("Unauthorized");
    }
    if (!res.ok) throw new Error("Failed to fetch");
    queue.value = await res.json();
    
    if (activeTab.value === 'pending') {
      let schedUrl = `/api/queue?status=scheduled`;
      if (connectionStore.activeConnectionId) {
         schedUrl += `&connectionId=${connectionStore.activeConnectionId}`;
      }
      const schedRes = await fetch(schedUrl, { headers: getAuthHeaders() });
      if (schedRes.ok) {
         scheduledQueue.value = await schedRes.json();
      }
      calculateExpectedTimes();
    } else {
      scheduledQueue.value = [];
    }
    
    error.value = "";
  } catch (err: any) {
    error.value = err.message;
  } finally {
    if (!silent) loading.value = false;
  }
};

const fetchActiveJobs = async () => {
  if (!connectionStore.activeConnectionId) {
    activeJobs.value = [];
    trackedInFlightJobIds.clear();
    return;
  }
  try {
    const res = await fetch(`/api/jobs/dashboard?connectionId=${connectionStore.activeConnectionId}`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) return;
    const jobs: any[] = await res.json();
    const currentInFlightIds = new Set<number>(
      jobs.filter(j => j.status === 'pending' || j.status === 'processing').map(j => j.id)
    );
    const errorIds = new Set<number>(
      jobs.filter(j => j.status === 'error').map(j => j.id)
    );

    let completedCount = 0;
    for (const prevId of trackedInFlightJobIds) {
      if (!currentInFlightIds.has(prevId) && !errorIds.has(prevId)) {
        completedCount++;
      }
    }

    trackedInFlightJobIds = currentInFlightIds;
    activeJobs.value = jobs;

    if (completedCount > 0) {
      toast.add({
        title: '🎉 Carousel Ready!',
        description: `${completedCount} background job(s) finished and added to your queue.`,
        color: 'success'
      });
      fetchQueue(true);
    }
  } catch (e) {}
};

const retryJobFromBanner = async (jobId: number) => {
  retryingJobId.value = jobId;
  try {
    const res = await fetch(`/api/jobs/${jobId}/retry`, {
      method: 'POST',
      headers: getAuthHeaders()
    });
    if (res.ok) {
      toast.add({ title: 'Job queued for retry', color: 'success' });
      await fetchActiveJobs();
    }
  } catch (e) {
  } finally {
    retryingJobId.value = null;
  }
};

const dismissJobFromBanner = async (jobId: number) => {
  try {
    const res = await fetch(`/api/jobs/${jobId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (res.ok) {
      activeJobs.value = activeJobs.value.filter(j => j.id !== jobId);
    }
  } catch (e) {}
};

const syncReorder = async () => {
  if (!connectionStore.activeConnectionId) return;
  try {
    calculateExpectedTimes();
    const res = await fetch(`/api/queue/reorder`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ 
         orderedIds: queue.value.map((i) => i.id),
         connectionId: connectionStore.activeConnectionId
      }),
    });
    if (res.status === 401) {
      toast.add({ title: "Unauthorized", description: "Please refresh and re-enter password.", color: "error" });
      return;
    }
  } catch (err) {
    toast.add({ title: "Failed to reorder items", color: "error" });
    fetchQueue();
  }
};

const onDragEnd = async () => {
  await syncReorder();
};

watch(() => connectionStore.activeConnectionId, () => {
  trackedInFlightJobIds.clear();
  fetchQueue();
  fetchSettings();
  fetchActiveJobs();
}, { immediate: true });

onMounted(() => {
  jobsPollTimer = setInterval(fetchActiveJobs, 4000);
});

onUnmounted(() => {
  if (jobsPollTimer) clearInterval(jobsPollTimer);
});

const jumpToPosition = async (currentIndex: number, event: Event) => {
  const target = event.target as HTMLInputElement;
  let newIndex = parseInt(target.value) - 1;

  if (newIndex >= queue.value.length) {
    newIndex = queue.value.length - 1;
  }

  if (
    isNaN(newIndex) ||
    newIndex < 0 ||
    newIndex === currentIndex
  ) {
    target.value = (currentIndex + 1).toString();
    return;
  }

  const newQueue = [...queue.value];
  const [movedItem] = newQueue.splice(currentIndex, 1);
  newQueue.splice(newIndex, 0, movedItem);
  queue.value = newQueue;

  target.value = (newIndex + 1).toString();
  await syncReorder();
};

const deleteItem = async (id: number) => {
  if (!confirm("Are you sure you want to delete this post?")) return;
  try {
    const res = await fetch(`/api/queue/${id}`, {
      method: "DELETE",
      headers: getAuthHeaders(),
    });
    if (res.status === 401) {
      toast.add({ title: "Unauthorized", color: "error" });
      return;
    }
    fetchQueue();
  } catch (err) {
    toast.add({ title: "Failed to delete", color: "error" });
  }
};

const updatePostStatus = async (id: number, status: 'pending' | 'draft') => {
  try {
    const res = await fetch(`/api/queue/${id}`, {
      method: "PUT",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.status === 401) {
      toast.add({ title: "Unauthorized", color: "error" });
      return;
    }
    if (!res.ok) throw new Error("Failed to update status");
    
    toast.add({ title: `Moved to ${status === 'draft' ? 'Drafts' : 'Pending Queue'}`, color: "success" });
    fetchQueue();
  } catch (err: any) {
    toast.add({ title: err.message, color: "error" });
  }
};

const duplicating = ref<Record<number, boolean>>({});

const duplicateToQueue = async (id: number) => {
  if (!confirm("Are you sure you want to duplicate this published post back to the queue?")) return;
  duplicating.value[id] = true;
  try {
    const res = await fetch(`/api/queue/${id}/duplicate`, {
      method: "POST",
      headers: getAuthHeaders(),
    });
    if (res.status === 401) {
      toast.add({ title: "Unauthorized", color: "error" });
      return;
    }
    const data = await res.json() as { error?: string; message?: string };
    if (!res.ok) throw new Error(data.error || "Failed to duplicate post");
    toast.add({ title: "Post duplicated to queue successfully!", color: "success" });
    fetchQueue();
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    toast.add({ title: errorMessage, color: "error" });
  } finally {
    duplicating.value[id] = false;
  }
};

const isPublishWarningModalOpen = ref(false);
const publishingPostId = ref<number | null>(null);
const upcomingSchedule = ref<{
  hasUpcoming: boolean;
  type?: 'scheduled_post' | 'auto_slot';
  minutesRemaining?: number;
  timeStr?: string;
  upcomingPostId?: number | null;
  upcomingPostTitle?: string | null;
  upcomingSlotDay?: string;
} | null>(null);
const isPublishing = ref(false);

const publishNow = async (id: number) => {
  publishingPostId.value = id;
  try {
    const scheduleRes = await fetch(`/api/queue/${id}/upcoming-schedule`, {
      headers: getAuthHeaders(),
    });
    if (scheduleRes.ok) {
      const scheduleData = await scheduleRes.json();
      if (scheduleData.hasUpcoming) {
        upcomingSchedule.value = scheduleData;
        isPublishWarningModalOpen.value = true;
        return;
      }
    }
  } catch (e) {
    console.warn('Failed to check upcoming schedule, proceeding with normal confirmation:', e);
  }

  if (!confirm("Are you sure you want to publish this post IMMEDIATELY to Buffer?")) return;
  executePublish(id, false);
};

const executePublish = async (id: number, skipUpcomingSlot: boolean) => {
  isPublishing.value = true;
  try {
    const res = await fetch(`/api/queue/${id}/publish`, {
      method: "POST",
      headers: {
        ...getAuthHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        skipUpcomingSlot,
        upcomingPostId: upcomingSchedule.value?.upcomingPostId,
      }),
    });
    if (res.status === 401) {
      toast.add({ title: "Unauthorized", color: "error" });
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to publish");
    
    const skipMsg = skipUpcomingSlot ? " (Jadwal berikutnya di-skip)" : "";
    toast.add({ title: `Published successfully!${skipMsg}`, color: "success" });
    isPublishWarningModalOpen.value = false;
    fetchQueue();
  } catch (err: any) {
    toast.add({ title: err.message, color: "error" });
  } finally {
    isPublishing.value = false;
  }
};

const retryError = async (id: number) => {
  if (!confirm("Are you sure you want to move this failed post back to the pending queue?")) return;
  try {
    const res = await fetch(`/api/queue/${id}/retry-error`, {
      method: "POST",
      headers: getAuthHeaders(),
    });
    if (res.status === 401) {
      toast.add({ title: "Unauthorized", color: "error" });
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to retry post");
    toast.add({ title: "Moved back to pending successfully!", color: "success" });
    fetchQueue();
  } catch (err: any) {
    toast.add({ title: err.message, color: "error" });
  }
};

const isFirstOfDay = (index: number) => {
  if (index === 0) return true;
  const current = queue.value[index].expectedPostAt;
  const previous = queue.value[index - 1].expectedPostAt;
  
  if (!current && !previous) return false;
  if (!current || !previous) return true;

  const d1 = new Date(current);
  const d2 = new Date(previous);
  
  return d1.toDateString() !== d2.toDateString();
};

const formatDayHeader = (dateObj: Date | string | null) => {
  if (!dateObj) return 'Unscheduled';
  
  const d = new Date(dateObj);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  const isToday = d.toDateString() === today.toDateString();
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  
  const dateStr = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric'
  }).format(d);

  if (isToday) return `Today, ${dateStr}`;
  if (isTomorrow) return `Tomorrow, ${dateStr}`;
  
  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'long'
  }).format(d);
  
  return `${weekday}, ${dateStr}`;
};

const formatTimeOnly = (dateObj: Date | string | null) => {
  if (!dateObj) return '-';
  const d = new Date(dateObj);
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(d);
};
const timeAgo = (dateObj: Date | string | null) => {
  if (!dateObj) return '';
  const d = new Date(dateObj);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - d.getTime()) / 1000);
  
  if (diffInSeconds < 60) return `${diffInSeconds} second${diffInSeconds !== 1 ? 's' : ''} ago`;
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes} minute${diffInMinutes !== 1 ? 's' : ''} ago`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours} hour${diffInHours !== 1 ? 's' : ''} ago`;
  const diffInDays = Math.floor(diffInHours / 24);
  return `${diffInDays} day${diffInDays !== 1 ? 's' : ''} ago`;
};

const getPostDropdownItems = (item: any) => {
  const actions: any[] = [];
  if (item?.postUrl) {
    actions.push({
      label: 'Copy Instagram Link',
      onSelect: () => {
        navigator.clipboard.writeText(item.postUrl);
        toast.add({ title: 'Instagram link copied to clipboard!', color: 'success' });
      }
    });
  }
  if (activeTab.value !== 'published') {
    actions.push({
      label: 'Delete',
      onSelect: () => deleteItem(item.id),
      color: 'error'
    });
  }
  return actions.length > 0 ? [actions] : [];
};
</script>

<template>
  <div>
    <div class="flex justify-between items-center mb-6">
      <h1 class="text-2xl font-bold text-default">Posts Queue</h1>
      <div class="flex items-center gap-2">
        <UButton
          to="/create"
          color="primary"
          variant="solid"
          size="md"
          :disabled="!connectionStore.activeConnectionId"
        >
          Create New
        </UButton>
        <UButton
          @click="() => { fetchQueue(); fetchActiveJobs(); }"
          color="primary"
          variant="solid"
          size="md"
        >
          Refresh
        </UButton>
      </div>
    </div>

    <!-- Live Background Jobs Banner -->
    <div v-if="activeJobs.length > 0 && connectionStore.activeConnectionId" class="mb-6 space-y-2.5">
      <div
        v-for="job in activeJobs"
        :key="job.id"
        class="rounded-xl border px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition shadow-xs"
        :class="
          job.status === 'processing'
            ? 'bg-primary/8 border-primary/40 ring-1 ring-primary/20'
            : job.status === 'pending'
              ? 'bg-amber-500/8 border-amber-500/30'
              : 'bg-red-500/8 border-red-500/30'
        "
      >
        <div class="flex items-start sm:items-center gap-3 min-w-0">
          <div class="mt-0.5 sm:mt-0 shrink-0">
            <Loader2 v-if="job.status === 'processing'" class="w-5 h-5 text-primary animate-spin" />
            <Sparkles v-else-if="job.status === 'pending'" class="w-5 h-5 text-amber-500 animate-pulse" />
            <AlertCircle v-else class="w-5 h-5 text-red-500" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="px-2 py-0.5 text-[10px] font-bold uppercase rounded-full"
                :class="
                  job.status === 'processing'
                    ? 'bg-primary text-inverted'
                    : job.status === 'pending'
                      ? 'bg-amber-500/20 text-amber-500 border border-amber-500/30'
                      : 'bg-red-500/20 text-red-500 border border-red-500/30'
                "
              >
                {{ job.status === 'processing' ? 'Generating Carousel...' : job.status === 'pending' ? 'Queued in Worker' : 'Generation Failed' }}
              </span>
              <span class="text-xs text-muted font-mono">
                #{{ job.id }} · {{ job.chatId === 'DASHBOARD' ? 'Web CMS' : job.chatId === 'NEWS_RADAR' ? 'News Radar' : job.chatId === 'OMP_EXTENSION' ? 'OMP Agent' : 'Telegram' }}
              </span>
              <span class="text-xs text-muted">· {{ timeAgo(job.createdAt) }}</span>
            </div>
            <p class="text-sm font-medium text-default line-clamp-1 mt-1">{{ job.text }}</p>
            <p v-if="job.status === 'error' && job.errorLog" class="text-xs text-red-500 mt-1 line-clamp-2">
              {{ job.errorLog }}
            </p>
          </div>
        </div>

        <div v-if="job.status === 'error'" class="flex items-center gap-2 shrink-0 self-end sm:self-center">
          <button
            type="button"
            @click="retryJobFromBanner(job.id)"
            :disabled="retryingJobId === job.id"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-default border border-default text-default hover:bg-muted disabled:opacity-50 cursor-pointer"
          >
            <RotateCcw class="w-3.5 h-3.5" :class="{ 'animate-spin': retryingJobId === job.id }" />
            Retry
          </button>
          <button
            type="button"
            @click="dismissJobFromBanner(job.id)"
            class="p-1.5 rounded-md text-muted hover:text-default hover:bg-muted cursor-pointer"
            title="Dismiss error"
          >
            <X class="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
    <UTabs 
      v-model="activeTab"
      :items="tabItems" 
      class="w-full mb-6"
      @update:modelValue="onTabChange"
    >
      <template #content="{ item: _item }">
        <div v-if="!connectionStore.activeConnectionId" class="text-center py-10 bg-default border border-default rounded-lg text-muted">
           Please select or create a connection from the sidebar.
        </div>
        <div v-else-if="loading" class="text-center py-10 text-muted">
          Loading queue...
        </div>
        <UAlert
          v-else-if="error"
          color="error"
          variant="soft"
          :description="error"
          class="mb-4"
        />
        <div
          v-else-if="queue.length === 0"
          class="text-center py-10 bg-default border border-default rounded-lg text-muted"
        >
          The queue is empty.
        </div>

        <div v-else class="overflow-hidden">
        
          <!-- Scheduled Queue (Non-draggable) -->
          <div v-if="activeTab === 'pending' && scheduledQueue.length > 0" class="mb-12 border-b border-default pb-8">
             <div class="mb-4 flex items-center gap-2 text-primary font-medium">
               <div class="i-lucide-calendar w-5 h-5"></div>
               <h2>Custom Scheduled Posts</h2>
             </div>
             <ul>
              <li v-for="qItem in scheduledQueue" :key="(qItem as any).id" class="relative mb-6">
                <div class="flex items-start gap-2 sm:gap-4">
                  <!-- Time Column -->
                  <div class="w-16 sm:w-20 flex-shrink-0 pt-5 flex flex-col items-end gap-1">
                     <span class="text-xs font-semibold text-primary uppercase text-right leading-tight">
                       {{ formatDayHeader((qItem as any).scheduledAt) }}
                     </span>
                     <span class="text-lg font-bold text-default text-right">
                       {{ formatTimeOnly((qItem as any).scheduledAt) }}
                     </span>
                  </div>

                  <!-- Drag Handle Spacer (to align with auto queue) -->
                  <div class="flex-shrink-0 w-10 flex flex-col items-center gap-2 pt-5">
                    <div class="i-lucide-lock text-muted w-4 h-4 mt-1"></div>
                  </div>

                  <!-- Item Card -->
                  <UCard class="flex-1 min-w-0 shadow-sm border-primary/30 ring-1 ring-primary/20 bg-primary/5 hover:shadow-md transition-shadow" :ui="{ body: 'p-4 sm:p-5', footer: 'px-4 py-3 sm:px-5' }">
                    <div class="flex flex-col sm:flex-row justify-between gap-6">
                      <!-- Left: Content -->
                      <div class="flex-1 min-w-0">
                        <p class="text-sm text-default whitespace-pre-wrap line-clamp-6">
                          {{ (qItem as any).text }}
                        </p>
                      </div>
                      <!-- Right: Media Grid -->
                      <div v-if="(qItem as any).media.length > 0" class="flex-shrink-0">
                        <div class="grid grid-cols-2 grid-rows-2 gap-0.5 w-full sm:w-56 h-56 rounded-md overflow-hidden bg-black border border-default">
                          <template v-for="(m, i) in (qItem as any).media.slice(0, 4)" :key="i">
                            <div 
                              @click="openLightbox((qItem as any).media, Number(i))"
                              class="relative cursor-pointer hover:opacity-90 transition group w-full h-full"
                              :class="{
                                'col-span-2 row-span-2': (qItem as any).media.length === 1,
                                'col-span-1 row-span-2': (qItem as any).media.length === 2,
                                'col-span-1 row-span-1': (qItem as any).media.length >= 3,
                              }"
                            >
                              <img :src="(m as any).url" class="w-full h-full object-cover" />
                              
                              <div v-if="i === 3 && (qItem as any).media.length > 4" class="absolute inset-0 bg-black/60 flex items-center justify-center">
                                <span class="text-white font-medium text-xl">+{{ (qItem as any).media.length - 4 }}</span>
                              </div>
                            </div>
                          </template>
                        </div>
                      </div>
                    </div>

                    <template #footer>
                      <div class="flex items-center justify-between">
                        <div class="text-sm text-muted">
                          You created this {{ timeAgo((qItem as any).createdAt) }}
                        </div>
                        <div class="flex items-center gap-2">
                          <UButton color="white" variant="solid" @click="publishNow((qItem as any).id as number)">
                            <template #leading><Send class="w-4 h-4" /></template>
                            Publish Now
                          </UButton>
                          <UButton color="white" variant="solid" @click="openScheduleModal(qItem)" :padded="false" class="p-2">
                            <div class="i-lucide-calendar-clock w-4 h-4 text-muted"></div>
                          </UButton>
                          <UButton color="white" variant="solid" @click="$router.push('/post/' + (qItem as any).id)" :padded="false" class="p-2">
                            <Edit class="w-4 h-4 text-muted" />
                          </UButton>
                          <UDropdownMenu :items="[[
                             { label: 'Clear Schedule', onSelect: () => clearSchedule((qItem as any).id as number), icon: 'i-lucide-calendar-off' },
                             { label: 'Move to Draft', onSelect: () => updatePostStatus((qItem as any).id as number, 'draft'), icon: 'i-lucide-file-text' },
                             { label: 'Delete', onSelect: () => deleteItem((qItem as any).id as number), color: 'error' }
                          ]]" :content="{ align: 'end' }">
                            <UButton color="white" variant="solid" :padded="false" class="p-2">
                              <MoreVertical class="w-4 h-4 text-muted" />
                            </UButton>
                          </UDropdownMenu>
                        </div>
                      </div>
                    </template>
                  </UCard>
                </div>
              </li>
             </ul>
          </div>
          
          <div v-if="activeTab === 'pending'" class="mb-4 flex items-center gap-2 text-default font-medium">
             <div class="i-lucide-list-ordered w-5 h-5"></div>
             <h2>Auto Queue</h2>
          </div>

          <draggable
            v-if="activeTab === 'pending'"
            v-model="queue"
            tag="ul"
            class=""
            handle=".drag-handle"
            ghost-class="opacity-50"
            @end="onDragEnd"
            item-key="id"
          >
            <template #item="{ element: qItem, index }">
              <li class="relative mb-6">
                <!-- Day Group Header -->
                <div v-if="isFirstOfDay(index)" class="pb-3 pt-6 first:pt-0">
                  <h2 class="text-lg font-medium text-default">{{ formatDayHeader(qItem.expectedPostAt) }}</h2>
                </div>

                <div class="flex items-start gap-2 sm:gap-4">
                  <!-- Time Column -->
                  <div class="w-16 sm:w-20 flex-shrink-0 pt-5 text-sm font-medium text-default text-right">
                    {{ formatTimeOnly(qItem.expectedPostAt) }}
                  </div>

                  <!-- Drag Handle & Jump -->
                  <div class="flex-shrink-0 pt-5 flex flex-col items-center gap-2">
                    <button class="drag-handle cursor-move text-muted hover:text-default">
                      <GripVertical class="w-5 h-5" />
                    </button>
                    <div class="flex items-center text-xs text-muted font-medium">
                      <span class="mr-1 text-muted">#</span>
                      <input
                        type="number"
                        :value="index + 1"
                        min="1"
                        :max="queue.length"
                        @change="(e) => jumpToPosition(index, e)"
                        class="w-10 px-1 py-1 text-center border border-default rounded bg-muted text-default focus:outline-none focus:ring-1 focus:ring-primary"
                        title="Jump to position"
                      />
                    </div>
                  </div>

                  <!-- Item Card -->
                  <UCard class="flex-1 min-w-0 shadow-sm hover:shadow-md transition-shadow" :ui="{ body: 'p-4 sm:p-5', footer: 'px-4 py-3 sm:px-5' }">
                    <div class="flex flex-col sm:flex-row justify-between gap-6">
                      
                      <!-- Left: Content -->
                      <div class="flex-1 min-w-0">
                        <p class="text-sm text-default whitespace-pre-wrap line-clamp-6">
                          {{ qItem.text }}
                        </p>
                      </div>
                      
                      <!-- Right: Media Grid -->
                      <div v-if="qItem.media.length > 0" class="flex-shrink-0">
                        <div class="grid grid-cols-2 grid-rows-2 gap-0.5 w-full sm:w-56 h-56 rounded-md overflow-hidden bg-black border border-default">
                          <template v-for="(m, i) in qItem.media.slice(0, 4)" :key="i">
                            <div 
                              @click="openLightbox(qItem.media, Number(i))"
                              class="relative cursor-pointer hover:opacity-90 transition group w-full h-full"
                              :class="{
                                'col-span-2 row-span-2': qItem.media.length === 1,
                                'col-span-1 row-span-2': qItem.media.length === 2,
                                'col-span-1 row-span-1': qItem.media.length >= 3,
                              }"
                            >
                              <img :src="m.url" class="w-full h-full object-cover" />
                              
                              <div v-if="i === 3 && qItem.media.length > 4" class="absolute inset-0 bg-black/60 flex items-center justify-center">
                                <span class="text-white font-medium text-xl">+{{ qItem.media.length - 4 }}</span>
                              </div>
                            </div>
                          </template>
                        </div>
                      </div>
                    </div>

                    <template #footer>
                      <div class="flex items-center justify-between">
                        <div class="text-sm text-muted">
                          You created this {{ timeAgo(qItem.createdAt) }}
                        </div>
                        <div class="flex items-center gap-2">
                          <UButton color="white" variant="solid" @click="publishNow(qItem.id)">
                            <template #leading><Send class="w-4 h-4" /></template>
                            Publish Now
                          </UButton>
                          <UButton color="white" variant="solid" @click="$router.push('/post/' + qItem.id)" :padded="false" class="p-2">
                            <Edit class="w-4 h-4 text-muted" />
                          </UButton>
                          <UDropdownMenu :items="[[
                            { label: 'Set Custom Schedule', onSelect: () => openScheduleModal(qItem), icon: 'i-lucide-calendar-clock' },
                            { label: 'Move to Draft', onSelect: () => updatePostStatus(qItem.id, 'draft'), icon: 'i-lucide-file-text' },
                            { label: 'Delete', onSelect: () => deleteItem(qItem.id), color: 'error' }
                          ]]" :content="{ align: 'end' }">
                            <UButton color="white" variant="solid" :padded="false" class="p-2">
                              <MoreVertical class="w-4 h-4 text-muted" />
                            </UButton>
                          </UDropdownMenu>
                        </div>
                      </div>
                    </template>
                  </UCard>
                </div>
              </li>
            </template>
          </draggable>
          <!-- Published / Error Lists (Non-draggable) -->
          <ul v-else class="">
            <li v-for="qItem in queue" :key="(qItem as any).id" class="relative mb-6">
              <div class="flex items-start gap-2 sm:gap-4">
                
                <!-- Tab specific column -->
                <div class="w-16 sm:w-20 flex-shrink-0 pt-5 flex flex-col items-end gap-2">
                   <UBadge :color="activeTab === 'published' ? 'success' : activeTab === 'draft' ? 'warning' : 'error'" class="justify-center uppercase text-[10px]">
                     {{ activeTab }}
                   </UBadge>
                   <span class="text-xs font-medium text-default text-right">
                     {{ formatTimeOnly(activeTab === 'published' ? (qItem as any).publishedAt : (qItem as any).createdAt) }}
                   </span>
                </div>

                <UCard class="flex-1 min-w-0 shadow-sm" :ui="{ body: 'p-4 sm:p-5', footer: 'px-4 py-3 sm:px-5' }">
                    <div class="flex flex-col sm:flex-row justify-between gap-6">
                      
                      <div class="flex-1 min-w-0">
                        <p class="text-sm text-default whitespace-pre-wrap line-clamp-6">
                          {{ (qItem as any).text }}
                        </p>
                        <div v-if="(qItem as any).errorLog" class="mt-4 text-xs text-error bg-red-50/10 p-3 rounded border border-red-200/20">
                          <span class="font-mono break-all">{{ (qItem as any).errorLog }}</span>
                        </div>
                      </div>
                      
                      <div v-if="(qItem as any).media.length > 0" class="flex-shrink-0">
                        <div class="grid grid-cols-2 grid-rows-2 gap-0.5 w-full sm:w-56 h-56 rounded-md overflow-hidden bg-black border border-default">
                          <template v-for="(m, i) in (qItem as any).media.slice(0, 4)" :key="i">
                            <div 
                              @click="openLightbox((qItem as any).media, Number(i))"
                              class="relative cursor-pointer hover:opacity-90 transition group w-full h-full"
                              :class="{
                                'col-span-2 row-span-2': (qItem as any).media.length === 1,
                                'col-span-1 row-span-2': (qItem as any).media.length === 2,
                                'col-span-1 row-span-1': (qItem as any).media.length >= 3,
                              }"
                            >
                              <img :src="(m as any).url" class="w-full h-full object-cover" />
                              
                              <div v-if="i === 3 && (qItem as any).media.length > 4" class="absolute inset-0 bg-black/60 flex items-center justify-center">
                                <span class="text-white font-medium text-xl">+{{ (qItem as any).media.length - 4 }}</span>
                              </div>
                            </div>
                          </template>
                        </div>
                      </div>
                    </div>

                    <template #footer>
                      <div class="flex items-center justify-between">
                        <div class="text-sm text-muted">
                          <span v-if="activeTab === 'published' && (qItem as any).publishedAt">
                            Published {{ timeAgo((qItem as any).publishedAt) }}
                          </span>
                          <span v-else>
                            Created {{ timeAgo((qItem as any).createdAt) }}
                          </span>
                        </div>
                        <div class="flex items-center gap-2">
                          <UButton v-if="activeTab === 'draft'" color="white" variant="solid" @click="updatePostStatus((qItem as any).id, 'pending')">
                            <template #leading><RotateCcw class="w-4 h-4" /></template>
                            Move to Pending
                          </UButton>
                          <UButton v-if="activeTab === 'draft'" color="white" variant="solid" @click="$router.push('/post/' + (qItem as any).id)" :padded="false" class="p-2">
                            <Edit class="w-4 h-4 text-muted" />
                          </UButton>
                          <UButton v-if="activeTab === 'error'" color="white" variant="solid" @click="retryError((qItem as any).id)">
                            <template #leading><RotateCcw class="w-4 h-4" /></template>
                            Retry
                          </UButton>
                          <UButton 
                            v-if="activeTab === 'published' && (qItem as any).postUrl" 
                            color="white" 
                            variant="solid" 
                            as="a"
                            :href="(qItem as any).postUrl" 
                            target="_blank" 
                            rel="noopener noreferrer"
                          >
                            <template #leading><ExternalLink class="w-4 h-4 text-emerald-500" /></template>
                            View on Instagram
                          </UButton>
                          <UButton v-if="activeTab === 'published'" color="white" variant="solid" :disabled="duplicating[(qItem as any).id]" @click="duplicateToQueue((qItem as any).id)">
                            <template #leading>
                              <Loader2 v-if="duplicating[(qItem as any).id]" class="w-4 h-4 animate-spin" />
                              <Copy v-else class="w-4 h-4" />
                            </template>
                            Duplicate to Queue
                          </UButton>
                          <UDropdownMenu 
                            v-if="getPostDropdownItems(qItem).length > 0" 
                            :items="getPostDropdownItems(qItem)" 
                            :content="{ align: 'end' }"
                          >
                            <UButton color="white" variant="solid" :padded="false" class="p-2">
                              <MoreVertical class="w-4 h-4 text-muted" />
                            </UButton>
                          </UDropdownMenu>
                        </div>
                      </div>
                    </template>
                  </UCard>
              </div>
            </li>
          </ul>
        </div>
      </template>
    </UTabs>
    
    <UModal v-model:open="isScheduleModalOpen" title="Set Custom Schedule">
       <template #body>
         <div class="space-y-4">
            <p class="text-sm text-muted">
               Choose a specific date and time for this post. It will ignore the global queue slots and be published exactly when you specify.
            </p>
            <div class="flex flex-col gap-1.5">
               <label class="text-sm font-medium text-default">Scheduled Date & Time</label>
               <input 
                 type="datetime-local" 
                 v-model="scheduleModalDate" 
                 class="w-full px-3 py-2 bg-default border border-default rounded-md text-default focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
               />
            </div>
         </div>
       </template>
       <template #footer>
          <div class="flex justify-end gap-2">
             <UButton color="white" variant="ghost" @click="isScheduleModalOpen = false">Cancel</UButton>
             <UButton color="primary" variant="solid" @click="saveSchedule" :disabled="!scheduleModalDate">Save Schedule</UButton>
          </div>
       </template>
    </UModal>

    <!-- Warning Modal: Upcoming Post Detected in Next 60 Minutes -->
    <UModal v-model:open="isPublishWarningModalOpen" title="⚠️ Upcoming Post Detected">
       <template #body>
         <div class="space-y-4" v-if="upcomingSchedule">
            <div class="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <p class="text-sm font-semibold text-amber-500 flex items-center gap-1.5">
                <span>⏱️ Next post is in {{ upcomingSchedule.minutesRemaining }} minutes</span>
                <span class="text-xs text-muted font-normal">({{ upcomingSchedule.timeStr }} WIB)</span>
              </p>
            </div>

            <p class="text-sm text-default">
              Postingan berikutnya dijadwalkan terbit dalam <b>{{ upcomingSchedule.minutesRemaining }} menit dari sekarang</b>.
            </p>

            <div v-if="upcomingSchedule.upcomingPostTitle" class="p-3 bg-elevated border border-default rounded-md text-xs text-muted italic">
              📌 "{{ upcomingSchedule.upcomingPostTitle }}"
            </div>

            <p class="text-sm text-muted">
              Karena Anda melakukan <b>Publish Now</b> saat ini, apakah Anda ingin <b>menge-skip</b> jadwal/slot postingan berikutnya tersebut agar jeda antar konten tidak terlalu rapat?
            </p>
         </div>
       </template>
       <template #footer>
          <div class="flex flex-col sm:flex-row justify-end gap-2 w-full">
             <UButton color="neutral" variant="ghost" @click="isPublishWarningModalOpen = false" :disabled="isPublishing">
                Cancel
             </UButton>
             <UButton color="neutral" variant="outline" @click="executePublish(publishingPostId!, false)" :loading="isPublishing">
                Publish & Biarkan Slot Tetap Jalan
             </UButton>
             <UButton color="primary" variant="solid" @click="executePublish(publishingPostId!, true)" :loading="isPublishing">
                ⏭️ Skip Slot & Publish Now
             </UButton>
          </div>
       </template>
    </UModal>
  </div>
</template>
