<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useRoute } from "vue-router";
import { useColorMode } from "@vueuse/core";
import { useConnectionStore } from "./store";
import { getAuthHeaders } from "./auth";
import type { NavigationMenuItem } from '@nuxt/ui';

const route = useRoute();
const colorMode = useColorMode();
const toggleColorMode = () => {
  colorMode.value = colorMode.value === "dark" ? "light" : "dark";
};

const connectionStore = useConnectionStore();
const connections = computed(() => connectionStore.connections);
const loading = computed(() => connectionStore.loadingConnections);
const sidebarOpen = ref(true);

const fetchConnections = async () => {
  await connectionStore.fetchConnections();
};

onMounted(() => {
  connectionStore.loadFromStorage();
  fetchConnections();
});

const createNewConnection = async () => {
  try {
    const res = await fetch("/api/connections", {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Connection" }),
    });
    if (res.ok) {
      const data = await res.json();
      await fetchConnections();
      connectionStore.setActiveConnection(data.connection.id);
    }
  } catch (err) {
    console.error(err);
  }
};

const sidebarNavItems = computed<NavigationMenuItem[]>(() => {
  if (loading.value) {
    return [{ label: 'Loading...', disabled: true, icon: 'i-lucide-loader-2' }];
  }
  
  const connItems = connections.value.map(conn => ({
    label: conn.name || 'Unnamed',
    icon: 'i-lucide-link',
    active: connectionStore.activeConnectionId === conn.id,
    onSelect(e: Event) {
      e.preventDefault();
      connectionStore.setActiveConnection(conn.id);
    }
  }));

  return [
    ...connItems,
    {
      label: 'Create connection',
      icon: 'i-lucide-circle-plus',
      onSelect(e: Event) {
        e.preventDefault();
        createNewConnection();
      }
    }
  ];
});

interface MainNavItem {
  label: string;
  icon: string;
  to: string;
}

const topNavItems = computed<MainNavItem[]>(() => [
  { label: 'Queue', icon: 'i-lucide-list', to: '/' },
  { label: 'Ideas', icon: 'i-lucide-lightbulb', to: '/ideas' },
  { label: 'Jobs', icon: 'i-lucide-briefcase', to: '/jobs' },
  { label: 'Settings', icon: 'i-lucide-settings', to: '/settings' },
]);
</script>

<template>
  <UApp>
    <div class="flex flex-1 h-screen overflow-hidden bg-default text-default">
      <USidebar
        v-model:open="sidebarOpen"
        collapsible="icon"
        rail
        class="hidden md:flex"
        :ui="{
          container: 'h-full',
          inner: 'bg-elevated/25 divide-transparent',
          body: 'py-0'
        }"
      >
        <template #header="{ state }">
          <div class="font-semibold text-sm px-2 py-1 text-muted uppercase tracking-wider" v-if="state === 'expanded'">
            Connections
          </div>
          <div v-else class="flex justify-center py-2">
            <UIcon name="i-lucide-plug" class="text-muted w-5 h-5" />
          </div>
        </template>

        <template #default="{ state }">
          <UNavigationMenu
            :key="state"
            :items="sidebarNavItems"
            orientation="vertical"
            :ui="{ link: 'p-1.5 overflow-hidden' }"
          />
        </template>

        <template #footer>
          <div class="flex flex-col gap-1 w-full">
            <UButton
              label="Global Settings"
              icon="i-lucide-globe"
              color="neutral"
              variant="ghost"
              class="w-full justify-start overflow-hidden"
              to="/global-settings"
            />
            <UButton
              :icon="colorMode === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
              color="neutral"
              variant="ghost"
              class="w-full justify-start overflow-hidden"
              label="Toggle Theme"
              @click="toggleColorMode"
            />
          </div>
        </template>
      </USidebar>

      <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div class="h-(--ui-header-height) shrink-0 flex items-center justify-between px-3 sm:px-4 border-b border-default bg-default z-10 gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <UButton
              icon="i-lucide-panel-left"
              color="neutral"
              variant="ghost"
              aria-label="Toggle sidebar"
              class="hidden md:inline-flex"
              @click="sidebarOpen = !sidebarOpen"
            />
            <h1 class="text-base sm:text-lg font-bold tracking-tight truncate shrink-0">Redaksi<span class="text-primary">.AI</span></h1>
          </div>
          
          <!-- Desktop Navigation -->
          <UNavigationMenu
            :items="topNavItems"
            orientation="horizontal"
            class="hidden md:flex flex-1 min-w-0 overflow-x-auto mx-4"
          />

          <!-- Quick Actions (Theme & Settings) -->
          <div class="flex items-center gap-1 shrink-0">
            <UButton
              to="/global-settings"
              icon="i-lucide-globe"
              color="neutral"
              variant="ghost"
              size="sm"
              class="md:hidden"
              aria-label="Global Settings"
            />
            <UButton
              :icon="colorMode === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
              color="neutral"
              variant="ghost"
              size="sm"
              aria-label="Toggle theme"
              @click="toggleColorMode"
            />
          </div>
        </div>

        <div class="flex-1 overflow-y-auto p-4 sm:p-8 pb-36 md:pb-8">
          <div class="max-w-5xl mx-auto w-full">
            <router-view></router-view>
          </div>
        </div>

        <!-- Mobile Bottom Dock (Connection Slider + Bottom Navigation Bar) -->
        <div class="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-default/95 backdrop-blur-lg border-t border-default shadow-lg pb-safe">
          <!-- Connection Slider -->
          <div class="px-3 py-2 border-b border-default/50 bg-elevated/40">
            <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              <span class="text-[10px] font-bold text-muted uppercase tracking-wider shrink-0 mr-1 flex items-center gap-1">
                <UIcon name="i-lucide-plug" class="w-3.5 h-3.5" />
                Account:
              </span>
              <button
                v-for="conn in connections"
                :key="conn.id"
                @click="connectionStore.setActiveConnection(conn.id)"
                class="shrink-0 px-3 py-1 rounded-full text-xs font-medium transition flex items-center gap-1.5 cursor-pointer"
                :class="connectionStore.activeConnectionId === conn.id
                  ? 'bg-primary text-white shadow-xs font-semibold'
                  : 'bg-default/80 hover:bg-default text-muted hover:text-default border border-default/80'"
              >
                <span class="w-1.5 h-1.5 rounded-full" :class="connectionStore.activeConnectionId === conn.id ? 'bg-white' : 'bg-muted'"></span>
                <span>{{ conn.name || 'Unnamed' }}</span>
              </button>
              <button
                @click="createNewConnection"
                class="shrink-0 px-2.5 py-1 rounded-full text-xs font-medium bg-default/50 hover:bg-default text-muted hover:text-default border border-dashed border-default flex items-center gap-1 cursor-pointer transition"
              >
                <UIcon name="i-lucide-plus" class="w-3.5 h-3.5" />
                <span>New</span>
              </button>
            </div>
          </div>

          <!-- Bottom Navigation Bar -->
          <div class="grid grid-cols-4 gap-1 px-2 pt-1.5 pb-1">
            <router-link
              v-for="item in topNavItems"
              :key="item.to"
              :to="item.to"
              class="flex flex-col items-center justify-center py-1 rounded-lg transition text-xs font-medium"
              :class="route.path === item.to
                ? 'text-primary font-semibold'
                : 'text-muted hover:text-default'"
            >
              <UIcon :name="item.icon!" class="w-5 h-5 mb-0.5" />
              <span class="text-[11px] leading-tight">{{ item.label }}</span>
            </router-link>
          </div>
        </div>
      </div>
    </div>
  </UApp>
</template>