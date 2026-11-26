<script setup lang="ts">
import { mdiAlertOctagonOutline, mdiShieldAlertOutline, mdiShieldCheck } from "@mdi/js";
import { computed } from "vue";

const props = defineProps<{ trust: ApiTrust; offline?: boolean }>();

const chip = computed(() => {
    if (props.offline) {
        return { color: undefined, icon: undefined, text: "offline" };
    }
    if (props.trust.level === "verified") {
        return { color: "success", icon: mdiShieldCheck, text: "verified" };
    }
    if (props.trust.nameConflict) {
        return { color: "error", icon: mdiAlertOctagonOutline, text: "name reused" };
    }
    return { color: "warning", icon: mdiShieldAlertOutline, text: "unverified" };
});
</script>

<template>
    <v-chip :color="chip.color" :prepend-icon="chip.icon" size="x-small" label variant="tonal">{{ chip.text }}</v-chip>
</template>
