<script setup lang="ts">
import { mdiCircle, mdiMagnify, mdiServerNetwork } from "@mdi/js";
import { computed, ref, watch } from "vue";
import { connectOrToast, relativeTime, search, setListed, setServer, shortFingerprint, state } from "../store";
import TrustChip from "./TrustChip.vue";

const url = ref("");
const listed = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const server = computed(() => state.server);
const connecting = computed(() => state.connecting);
// Read through computeds: vue-tsc mistypes the imported reactive `state` inside <template v-else>.
const found = computed(() => state.search);

// Offer the public server whenever none is joined.
watch(() => server.value.defaultUrl, (value) => {
    url.value ||= value;
}, { immediate: true });

const signaling = computed(() => {
    switch (server.value.signaling) {
        case "online":
            return { color: "success", text: "online" };
        case "connecting":
            return { color: "info", text: "connecting" };
        case "error":
            return { color: "error", text: "error" };
        default:
            return { color: undefined, text: "off" };
    }
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;
function onSearchInput(value: string): void {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void search(value), 300);
}

async function join(): Promise<void> {
    busy.value = true;
    error.value = await setServer(url.value, listed.value);
    busy.value = false;
    if (!error.value) {
        url.value = server.value.defaultUrl;
    }
}

async function leave(): Promise<void> {
    busy.value = true;
    error.value = await setServer(null, server.value.listed);
    busy.value = false;
}

/** "Open" for someone we're already talking to, "Connect" otherwise. */
function isLive(fingerprint: string): boolean {
    return state.conversations.get(fingerprint)?.peer != null;
}
</script>

<template>
    <v-card>
        <v-card-item :prepend-icon="mdiServerNetwork" title="Server">
            <template #append>
                <v-chip data-testid="server-status" :color="signaling.color" size="x-small" label variant="tonal">
                    {{ signaling.text }}
                </v-chip>
            </template>
        </v-card-item>

        <v-card-text v-if="!server.url">
            <p class="mb-3 text-xs leading-relaxed text-muted">
                A server lets people on other networks reach you by fingerprint. It only relays connection setup and
                never sees your messages. It stores no IP addresses; if you choose to be findable, it keeps your name
                and identity key.
            </p>
            <v-form data-testid="server-form" @submit.prevent="join">
                <v-text-field
                    v-model="url"
                    data-testid="server-url"
                    label="Server URL"
                    placeholder="https://chat.example.com"
                    spellcheck="false"
                    autocomplete="off"
                    hide-details
                />
                <v-switch
                    v-model="listed"
                    data-testid="server-listed"
                    color="primary"
                    density="compact"
                    hide-details
                    label="Let people find me by name"
                    class="mt-1"
                />
                <v-btn data-testid="server-join" type="submit" block variant="tonal" class="mt-1" :loading="busy">Join</v-btn>
            </v-form>
        </v-card-text>

        <template v-else>
            <v-card-text class="pb-2">
                <div class="flex items-center gap-1">
                    <span class="grow truncate font-mono text-sm" :title="server.url ?? undefined">{{ server.url }}</span>
                    <v-btn size="small" variant="text" color="error" :loading="busy" @click="leave">Leave</v-btn>
                </div>
                <v-switch
                    :model-value="server.listed"
                    color="primary"
                    density="compact"
                    hide-details
                    label="Let people find me by name"
                    @update:model-value="setListed($event === true)"
                />
                <v-alert
                    v-if="server.signaling === 'error' || server.directory === 'error'"
                    type="error"
                    variant="tonal"
                    density="compact"
                    class="mt-1"
                    :text="server.error ?? 'The server is unreachable.'"
                />

                <v-text-field
                    data-testid="search"
                    :model-value="found.query"
                    :prepend-inner-icon="mdiMagnify"
                    label="Find someone by name"
                    spellcheck="false"
                    autocomplete="off"
                    hide-details
                    clearable
                    :loading="found.busy"
                    class="mt-3"
                    @update:model-value="onSearchInput($event ?? '')"
                />
                <v-alert
                    v-if="found.error"
                    type="error"
                    variant="tonal"
                    density="compact"
                    class="mt-2"
                    :text="found.error"
                />
                <v-alert
                    v-if="found.rejected > 0"
                    type="warning"
                    variant="tonal"
                    density="compact"
                    class="mt-2"
                    :text="`${found.rejected} result(s) failed their signature check and were hidden. The server may be broken or malicious.`"
                />
            </v-card-text>

            <v-list v-if="found.query.trim().length >= 2" density="compact" class="pt-0">
                <v-list-item
                    v-for="entry in found.results"
                    :key="entry.fingerprint"
                    data-testid="search-result"
                    :data-name="entry.name"
                >
                    <template #prepend>
                        <v-icon
                            :icon="mdiCircle"
                            size="10"
                            :color="entry.online ? 'success' : 'grey'"
                            :title="entry.online ? 'online' : 'offline'"
                            class="mr-3"
                        />
                    </template>
                    <v-list-item-title class="flex items-center gap-2">
                        <span class="truncate">{{ entry.name }}</span>
                        <TrustChip v-if="entry.trust.level !== 'new' || entry.trust.nameConflict" :trust="entry.trust" />
                    </v-list-item-title>
                    <v-list-item-subtitle>
                        <span class="font-mono">{{ shortFingerprint(entry.fingerprint) }}</span>
                        · {{ entry.online ? "online" : `listed ${relativeTime(entry.lastSeen)}` }}
                    </v-list-item-subtitle>
                    <template #append>
                        <v-btn
                            data-testid="search-connect"
                            size="small"
                            variant="tonal"
                            :color="isLive(entry.fingerprint) ? undefined : 'primary'"
                            :disabled="!entry.online && !isLive(entry.fingerprint)"
                            :loading="connecting === entry.fingerprint"
                            @click="connectOrToast(entry.fingerprint)"
                        >
                            {{ isLive(entry.fingerprint) ? "Open" : "Connect" }}
                        </v-btn>
                    </template>
                </v-list-item>
                <v-list-item v-if="!found.busy && found.results.length === 0 && !found.error">
                    <span class="text-xs text-muted">Nobody listed under that name.</span>
                </v-list-item>
            </v-list>
        </template>

        <v-card-text v-if="error" class="pt-0">
            <v-alert type="error" variant="tonal" density="compact" :text="error" />
        </v-card-text>
    </v-card>
</template>
