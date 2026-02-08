<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  remainingCount?: number;
  totalCount?: number;
}>();

const currentNumber = computed(() => {
  if (props.totalCount === undefined || props.remainingCount === undefined) return undefined;
  return Math.min(props.totalCount, Math.max(1, props.totalCount - props.remainingCount + 1));
});

const label = computed(() => {
  if (props.totalCount === undefined || props.remainingCount === undefined) return 'Generating image...';
  if (props.totalCount <= 1) return 'Generating image...';
  return `Generating images (${currentNumber.value} / ${props.totalCount})`;
});
</script>

<template>
  <div class="relative w-full max-w-[400px] aspect-square rounded-3xl overflow-hidden flex items-center justify-center group/conjure" data-testid="image-conjuring-loader">
    <!-- Ambient Glow & Grid -->
    <div class="absolute inset-0 pointer-events-none">
      <div class="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.15)_0%,transparent_70%)]"></div>
      <div class="absolute inset-0 opacity-[0.05] dark:opacity-[0.1]" style="background-image: linear-gradient(rgba(59,130,246,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(59,130,246,0.3) 1px, transparent 1px); background-size: 48px 48px; mask-image: radial-gradient(circle at center, black, transparent 80%);"></div>
    </div>
    
    <!-- Magical Particles (More visible & vibrant) -->
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div v-for="i in 30" :key="i" class="magic-particle" 
           :style="`
          --d: ${Math.random() * 360}deg; 
          --t: ${3 + Math.random() * 2}s; 
          --del: -${Math.random() * 5}s; 
          --size: ${1.2 + Math.random() * 3}px;
          --dist: ${100 + Math.random() * 80}px;
          --color: ${i % 6 === 0 ? '#fbbf24' : '#3b82f6'}
        `">
      </div>
    </div>

    <!-- Central Core -->
    <div class="relative flex flex-col items-center gap-6">
      <!-- Stronger ambient glow around text -->
      <div class="absolute w-40 h-40 bg-blue-500/15 blur-[50px] animate-pulse"></div>
      
      <!-- Typography: Increased opacity and vibrance -->
      <div class="relative z-10 flex flex-col items-center gap-3">
        <span class="text-[11px] font-mono font-bold text-blue-400 dark:text-blue-300 animate-subtle-pulse mix-blend-plus-lighter whitespace-nowrap drop-shadow-[0_0_8px_rgba(96,165,250,0.5)]">
          {{ label }}
        </span>
        
        <!-- Progress Indicators (Dots) for multiple images -->
        <div v-if="totalCount && totalCount > 1" class="flex gap-1.5">
          <div 
            v-for="i in totalCount" 
            :key="i"
            class="w-1.5 h-1.5 rounded-full transition-all duration-500"
            :class="[
              i < (currentNumber || 0) ? 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]' : 
              i === (currentNumber || 0) ? 'bg-blue-400 animate-pulse scale-125' : 
              'bg-gray-200 dark:bg-gray-700'
            ]"
          ></div>
        </div>

        <!-- Breathing line (fallback for single image or when count unknown) -->
        <div v-else class="w-10 h-[1px] bg-gradient-to-r from-transparent via-blue-500/60 to-transparent shadow-[0_0_10px_rgba(59,130,246,0.3)]"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@keyframes subtle-pulse {
  0%, 100% { opacity: 0.5; transform: scale(0.97); }
  50% { opacity: 1; transform: scale(1); }
}
.animate-subtle-pulse {
  animation: subtle-pulse 3s ease-in-out infinite;
}

.magic-particle {
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--size);
  height: var(--size);
  background: var(--color);
  border-radius: 50%;
  box-shadow: 0 0 calc(var(--size) * 3) var(--color);
  opacity: 0;
  animation: particle-expansion var(--t) ease-out infinite;
  animation-delay: var(--del);
}

@keyframes particle-expansion {
  0% {
    transform: rotate(var(--d)) translateX(0) scale(0);
    opacity: 0;
  }
  15% {
    opacity: 0.8; /* Significantly higher opacity */
    transform: rotate(var(--d)) translateX(30px) scale(1.2);
  }
  100% {
    transform: rotate(var(--d)) translateX(var(--dist)) scale(0.2);
    opacity: 0;
  }
}
</style>