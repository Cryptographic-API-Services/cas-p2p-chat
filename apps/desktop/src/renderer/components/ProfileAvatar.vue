<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
    /** A data URL checked by the main process, or null/undefined for none. */
    avatar?: ApiAvatar | null;
    name: string;
    size?: number;
    /** The placeholder's tint; "white" on the primary-colored app bar. */
    color?: string;
}>();

// The main process only ever hands over validated image data URLs; this is a second guard, so
// nothing else can end up as an <img src>.
const src = computed(() => (props.avatar?.startsWith("data:image/") ? props.avatar : null));

/** "Echo Bot" → "EB", "alice" → "A": shown when there's no photo. */
const initials = computed(() => {
    const words = props.name.trim().split(/\s+/).filter(Boolean);
    const first = (word: string | undefined) => (word ? [...word][0] : "");
    return (first(words[0]) + (words.length > 1 ? first(words.at(-1)) : "")).toUpperCase() || "?";
});
</script>

<template>
    <v-avatar :size="size ?? 40" :color="color ?? 'primary'" variant="tonal">
        <img v-if="src" :src="src" :alt="name" class="h-full w-full object-cover" draggable="false" />
        <span v-else class="font-medium select-none" :style="{ fontSize: `${Math.round((size ?? 40) * 0.38)}px` }">{{ initials }}</span>
    </v-avatar>
</template>
