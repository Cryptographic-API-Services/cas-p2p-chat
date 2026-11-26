<script setup lang="ts">
import { mdiConnection } from "@mdi/js";
import { computed, ref } from "vue";
import { connect, state } from "../store";

const target = ref("");
const error = ref<string | null>(null);
const busy = computed(() => state.connecting !== null && state.connecting === target.value.trim());

async function submit(): Promise<void> {
    error.value = null;
    if (target.value.trim() === "") {
        error.value = "Enter a fingerprint.";
        return;
    }
    error.value = await connect(target.value);
    if (!error.value) {
        target.value = "";
    }
}
</script>

<template>
    <v-card>
        <v-card-item :prepend-icon="mdiConnection" title="Connect" />
        <v-card-text>
            <v-form data-testid="connect-form" @submit.prevent="submit">
                <v-text-field
                    v-model="target"
                    data-testid="connect-target"
                    label="Fingerprint"
                    placeholder="ABCD 1234 EF56 …"
                    spellcheck="false"
                    autocomplete="off"
                    hide-details
                />
                <p class="mt-2 text-xs leading-relaxed text-muted">
                    Connects through your server, from anywhere. People who aren't listed by name can still be reached
                    by fingerprint.
                </p>
                <v-btn type="submit" color="primary" block class="mt-3" :loading="busy">Connect</v-btn>
            </v-form>
            <v-alert
                v-if="error"
                data-testid="connect-error"
                type="error"
                variant="tonal"
                density="compact"
                class="mt-3"
                :text="`Could not connect: ${error}`"
            />
        </v-card-text>
    </v-card>
</template>
