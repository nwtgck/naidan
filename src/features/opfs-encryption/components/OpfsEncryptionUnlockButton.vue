<script setup lang="ts">
import { computed } from 'vue';
import type { OpfsEncryptionUnlockButtonState } from './opfs-encryption-unlock-button-motion';

const props = defineProps<{
  state: OpfsEncryptionUnlockButtonState,
  disabled: boolean,
  label: string | undefined,
  resultLabel: string | undefined,
}>();

const isRetracting = computed(() => props.state === 'retracting');
const isSeating = computed(() => props.state === 'seating');
const isUnlocked = computed(() => props.state === 'unlocked');
const accessibleLabel = computed(() => {
  const state = props.state;
  switch (state) {
  case 'ready':
  case 'retracting':
    return props.label;
  case 'seating':
  case 'unlocked':
    return props.resultLabel;
  default: {
    const _ex: never = state;
    throw new Error(`Unhandled OPFS unlock button state: ${String(_ex)}`);
  }
  }
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here.
    },
  }) || {}),
});
</script>

<template>
  <button
    type="submit"
    data-testid="opfs-encryption-unlock-submit"
    class="unlock-button"
    :class="{
      'is-retracting': isRetracting,
      'is-seating': isSeating,
      'is-unlocked': isUnlocked,
    }"
    :data-state="state"
    :disabled="disabled"
    :aria-label="accessibleLabel"
    :aria-busy="state === 'retracting' || state === 'seating' ? 'true' : undefined"
  >
    <span class="unlock-base">
      <span class="unlock-result" aria-live="polite">
        {{ resultLabel }}
      </span>
    </span>

    <span class="unlock-shutter">
      <span class="shutter-marks" aria-hidden="true">
        <span />
        <span />
      </span>

      <span class="shutter-label">
        {{ label }}
      </span>
    </span>

    <span class="lock-cap" aria-hidden="true">
      <span class="lock-cap-surface" />

      <span class="lock-icon">
        <span class="lock-shackle" />

        <span class="lock-body">
          <span class="lock-keyhole" />
        </span>
      </span>
    </span>
  </button>
</template>

<style scoped>
.unlock-button {
  --unlock-inset: 5px;
  --unlock-cap-width: 60px;
  --unlock-pre-seat-width: 35px;
  --unlock-stored-width: 28px;
  --unlock-text: #f8fafc;
  --unlock-base-bg: #1b2840;
  --unlock-base-border: #33435e;
  --unlock-primary: #2d5de5;
  --unlock-primary-hover: #3566ed;
  --unlock-primary-edge: #527fff;

  /*
   * Keep the completed-state palette identical to the approved motion mock.
   * These colors are intentionally not derived from application theme tokens,
   * because the lock confirmation must not drift as the surrounding UI evolves.
   */
  --unlock-success: #18805f;
  --unlock-success-edge: #3eaf87;
  --unlock-success-icon: #fff;
  --unlock-success-text: #f4f7ff;

  position: relative;
  width: 100%;
  height: 66px;
  margin-top: 0.5rem;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--unlock-base-border);
  border-radius: 19px;
  color: var(--unlock-text);
  background: var(--unlock-base-bg);
  box-shadow:
    inset 0 1px rgb(255 255 255 / 5%),
    0 12px 26px rgb(0 0 0 / 22%);
  cursor: pointer;
  appearance: none;
  touch-action: manipulation;
}

/*
 * This remains a normal click or tap button. The horizontal movement is
 * feedback only and must never imply drag or swipe interaction.
 */
.unlock-button:disabled {
  cursor: default;
  opacity: 1;
}

.unlock-button:focus-visible {
  outline: 3px solid rgb(67 133 255 / 42%);
  outline-offset: 4px;
}

.unlock-base {
  position: absolute;
  inset: var(--unlock-inset);
  display: grid;
  place-items: center;
  padding-right: var(--unlock-cap-width);
  border-radius: 14px;
  background: var(--unlock-base-bg);
  box-shadow:
    inset 0 1px rgb(255 255 255 / 4%),
    inset 0 0 0 1px rgb(0 0 0 / 12%);
}

/*
 * The completed label belongs to the fixed floor. Revealing it through
 * clipping makes the retracting shutter physically uncover the result.
 */
.unlock-result {
  visibility: hidden;
  clip-path: inset(0 100% 0 0);
  color: var(--unlock-success-text);
  font-size: 18px;
  font-weight: 850;
  letter-spacing: 0.012em;
}

/*
 * The shutter stays behind the opaque lock cap. It never fades, scales,
 * overshoots, reverses, passes through the cap, or shrinks to zero.
 */
.unlock-shutter {
  position: absolute;
  top: var(--unlock-inset);
  right: var(--unlock-inset);
  bottom: var(--unlock-inset);
  z-index: 2;
  width: calc(100% - 2 * var(--unlock-inset));
  min-width: var(--unlock-stored-width);
  overflow: hidden;
  border-radius: 14px;
  color: white;
  background: var(--unlock-primary);
  box-shadow:
    inset 0 0 0 1px var(--unlock-primary-edge),
    inset 0 1px rgb(255 255 255 / 14%),
    inset 0 -1px rgb(0 0 0 / 10%);
  will-change: width;
}

.unlock-button:hover:not(:disabled) .unlock-shutter,
.unlock-button:hover:not(:disabled) .lock-cap,
.unlock-button:hover:not(:disabled) .lock-cap-surface {
  background: var(--unlock-primary-hover);
}

/*
 * Retraction and seating are separate physical actions. JavaScript holds the
 * shutter motionless at the pre-seat width until both authenticated decryption
 * and the minimum hold time have completed, then enables the final short snap.
 */
.unlock-button.is-retracting .unlock-shutter {
  animation: retract-to-contact 720ms forwards;
}

.unlock-button.is-seating .unlock-shutter {
  width: var(--unlock-pre-seat-width);
  animation: snap-into-seat 90ms cubic-bezier(.22, .72, .3, 1) forwards;
}

.unlock-button.is-unlocked .unlock-shutter {
  width: var(--unlock-stored-width);
}

.shutter-marks {
  position: absolute;
  top: 50%;
  left: 20px;
  display: flex;
  gap: 5px;
  transform: translateY(-50%);
}

.shutter-marks span {
  width: 3px;
  height: 14px;
  border-radius: 999px;
  background: rgb(15 48 143 / 55%);
  box-shadow: 1px 0 rgb(255 255 255 / 10%);
}

.shutter-label {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding-inline: 72px;
  overflow: hidden;
  font-size: 15px;
  font-weight: 800;
  white-space: nowrap;
}

/*
 * The opaque cap, not the icon geometry, hides the stored shutter from the
 * surrounding empty space.
 */
.lock-cap {
  position: absolute;
  top: var(--unlock-inset);
  right: var(--unlock-inset);
  bottom: var(--unlock-inset);
  z-index: 4;
  width: var(--unlock-cap-width);
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--unlock-primary-edge);
  border-radius: 14px;
  color: var(--unlock-success-icon);
  background: var(--unlock-primary);
  isolation: isolate;
  box-shadow:
    inset 0 1px rgb(255 255 255 / 14%),
    -2px 0 5px rgb(20 53 151 / 24%);
  transition:
    background-color 150ms linear,
    border-color 150ms linear,
    box-shadow 150ms linear;
}

.lock-cap-surface {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: var(--unlock-primary);
  transition: background-color 150ms linear;
}

.lock-icon {
  position: relative;
  z-index: 1;
  width: 23px;
  height: 29px;
}

.lock-body {
  position: absolute;
  right: 1px;
  bottom: 0;
  left: 1px;
  height: 18px;
  border-radius: 5px;
  background: currentcolor;
}

.lock-keyhole {
  position: absolute;
  top: 6px;
  left: 50%;
  width: 3px;
  height: 6px;
  border-radius: 999px;
  background: var(--unlock-primary);
  transform: translateX(-50%);
  transition: background-color 150ms linear;
}

.lock-shackle {
  position: absolute;
  top: 0;
  left: 5px;
  width: 14px;
  height: 16px;
  border: 3px solid currentcolor;
  border-bottom: 0;
  border-radius: 9px 9px 0 0;
  transform: translate(0, 0) rotate(0deg);
  transform-origin: 3px 14px;
}

/*
 * Green is deliberately limited to the compact lock mechanism. The exposed
 * floor stays neutral so the completed state remains calm and unambiguous.
 */
.unlock-button.is-seating .lock-cap,
.unlock-button.is-unlocked .lock-cap {
  border-color: var(--unlock-success-edge);
  background: var(--unlock-success);
  box-shadow:
    inset 0 1px rgb(255 255 255 / 13%),
    -1px 0 rgb(0 0 0 / 18%);
}

.unlock-button.is-seating .lock-cap-surface,
.unlock-button.is-unlocked .lock-cap-surface,
.unlock-button.is-seating .lock-keyhole,
.unlock-button.is-unlocked .lock-keyhole {
  background: var(--unlock-success);
}

/*
 * The lock opens only after authenticated decryption succeeds and the final
 * seating motion begins. Authentication failure can never display success.
 */
.unlock-button.is-seating .lock-shackle {
  animation: open-lock 150ms cubic-bezier(.2, .68, .28, 1) forwards;
}

.unlock-button.is-unlocked .lock-shackle {
  transform: translate(3px, -2px) rotate(22deg);
}

.unlock-button.is-seating .unlock-result {
  visibility: visible;
  animation: reveal-unlocked 190ms cubic-bezier(.2, .72, .24, 1) forwards;
}

.unlock-button.is-unlocked .unlock-result {
  visibility: visible;
  clip-path: inset(0);
}

@keyframes retract-to-contact {
  0% {
    width: calc(100% - 2 * var(--unlock-inset));
    animation-timing-function: cubic-bezier(.4, 0, .68, .28);
  }

  8% {
    width: calc(95% - 2 * var(--unlock-inset));
    animation-timing-function: cubic-bezier(.06, .4, .14, .99);
  }

  89% {
    width: calc(var(--unlock-cap-width) + 5px);
    animation-timing-function: cubic-bezier(.08, .5, .16, .98);
  }

  100% {
    width: var(--unlock-pre-seat-width);
  }
}

@keyframes snap-into-seat {
  from {
    width: var(--unlock-pre-seat-width);
  }

  to {
    width: var(--unlock-stored-width);
  }
}

@keyframes open-lock {
  0% {
    transform: translate(0, 0) rotate(0deg);
  }

  32% {
    transform: translate(0, -2px) rotate(0deg);
  }

  100% {
    transform: translate(3px, -2px) rotate(22deg);
  }
}

@keyframes reveal-unlocked {
  from {
    clip-path: inset(0 100% 0 0);
  }

  to {
    clip-path: inset(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .unlock-button.is-retracting .unlock-shutter,
  .unlock-button.is-seating .unlock-shutter,
  .unlock-button.is-seating .lock-shackle,
  .unlock-button.is-seating .unlock-result {
    animation-duration: 1ms;
  }

  .lock-cap,
  .lock-cap-surface,
  .lock-keyhole {
    transition-duration: 1ms;
  }
}
</style>
