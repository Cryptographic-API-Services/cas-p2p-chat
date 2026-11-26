<script setup lang="ts">
import { mdiConnection, mdiDeleteOutline, mdiLinkVariantOff, mdiLockOutline, mdiSend, mdiShieldCheck, mdiShieldOffOutline } from "@mdi/js";
import { computed, nextTick, ref, watch } from "vue";
import { Conversation, clearHistory, connectOrToast, disconnect, send, state, toggleVerified } from "../store";
import TrustChip from "./TrustChip.vue";

const props = defineProps<{ conversation: Conversation }>();

const draft = ref("");
const sending = ref(false);
const confirmClear = ref(false);
const scroller = ref<HTMLElement | null>(null);

/** A live chat session with them, not whether they're running the app. */
const connected = computed(() => props.conversation.peer !== null);
const verified = computed(() => props.conversation.trust.level === "verified");
const canReconnect = computed(() => state.server.signaling === "online");
const reconnecting = computed(() => state.connecting === props.conversation.fingerprint);
const where = computed(() => (props.conversation.peer ? "connected (WebRTC)" : reconnecting.value ? "connecting…" : "not connected"));

function clock(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function submit(): Promise<void> {
    if (sending.value || draft.value.trim() === "") {
        return;
    }
    sending.value = true;
    if (await send(draft.value)) {
        draft.value = "";
    }
    sending.value = false;
}

async function clear(): Promise<void> {
    confirmClear.value = false;
    await clearHistory(props.conversation);
}

function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void submit();
    }
}

/** Follows new messages, unless the user has scrolled up to read older ones. */
function scrollToBottom(force = false): void {
    const el = scroller.value;
    if (el && (force || el.scrollHeight - el.scrollTop - el.clientHeight < 80)) {
        void nextTick(() => {
            el.scrollTop = el.scrollHeight;
        });
    }
}

watch(() => props.conversation.lines.length, () => scrollToBottom());
watch(() => props.conversation.fingerprint, () => {
    draft.value = "";
    scrollToBottom(true);
}, { immediate: true });
</script>

<template>
    <div class="flex h-full flex-col">
        <v-toolbar color="surface" density="comfortable" class="flex-none border-b border-line">
            <div class="min-w-0 px-4">
                <div class="flex items-center gap-2">
                    <span class="truncate text-lg font-medium" data-testid="peer-name">{{ conversation.name }}</span>
                    <TrustChip data-testid="peer-badge" :trust="conversation.trust" :disconnected="!connected" />
                </div>
                <div class="text-xs text-muted">
                    <span class="font-mono">{{ conversation.fingerprint }}</span> · <span data-testid="peer-where">{{ where }}</span>
                </div>
            </div>
            <template #append>
                <v-btn
                    variant="tonal"
                    :color="verified ? undefined : 'success'"
                    :prepend-icon="verified ? mdiShieldOffOutline : mdiShieldCheck"
                    class="mr-2"
                    @click="toggleVerified(conversation)"
                >
                    {{ verified ? "Remove verification" : "Mark as verified" }}
                </v-btn>
                <v-btn v-if="connected" data-testid="disconnect" variant="text" :prepend-icon="mdiLinkVariantOff" @click="disconnect(conversation)">
                    Disconnect
                </v-btn>
                <v-btn
                    v-else
                    data-testid="reconnect"
                    variant="text"
                    color="primary"
                    :prepend-icon="mdiConnection"
                    :disabled="!canReconnect"
                    :loading="reconnecting"
                    :title="canReconnect ? 'Connect through your server' : 'Join a server to reconnect by fingerprint'"
                    @click="connectOrToast(conversation.fingerprint)"
                >
                    Connect
                </v-btn>
                <v-btn
                    data-testid="clear-history"
                    :icon="mdiDeleteOutline"
                    variant="text"
                    title="Delete saved messages"
                    @click="confirmClear = true"
                />
            </template>
        </v-toolbar>

        <v-dialog v-model="confirmClear" max-width="440">
            <v-card title="Delete saved messages?">
                <v-card-text>
                    This deletes every message with {{ conversation.name }} saved on this device. It can't be undone,
                    and it doesn't delete {{ conversation.name }}'s copies.
                </v-card-text>
                <v-card-actions class="justify-end">
                    <v-btn @click="confirmClear = false">Cancel</v-btn>
                    <v-btn data-testid="clear-history-confirm" color="error" @click="clear">Delete</v-btn>
                </v-card-actions>
            </v-card>
        </v-dialog>

        <v-alert
            v-if="conversation.trust.nameConflict && !verified"
            type="error"
            variant="tonal"
            rounded="0"
            density="compact"
            class="flex-none"
        >
            <strong>Name already used by another key.</strong>
            A different device has connected as “{{ conversation.name }}” before. This could be {{ conversation.name }}
            on a new device, or someone pretending to be them. Compare fingerprints before trusting this conversation.
        </v-alert>
        <v-alert v-else-if="!verified" type="warning" variant="tonal" rounded="0" density="compact" class="flex-none">
            <strong>Not verified yet.</strong>
            Ask {{ conversation.name }} to read out the fingerprint under “This device” on their screen, in person or
            on a call, and check that it is <strong class="font-mono">{{ conversation.fingerprint }}</strong>. If it
            matches, mark them as verified.
        </v-alert>

        <div ref="scroller" class="grow overflow-y-auto p-4" data-testid="messages">
            <div v-if="conversation.lines.length === 0" class="mx-auto my-6 max-w-[80%] text-center text-xs text-muted">
                No messages yet. Messages are saved on this device, encrypted.
            </div>
            <template v-for="(line, index) in conversation.lines" :key="index">
                <div v-if="line.kind === 'system'" class="mx-auto my-3 max-w-[80%] text-center text-xs text-muted">
                    <v-icon :icon="mdiLockOutline" size="x-small" class="mr-1" />{{ line.text }}
                </div>
                <div v-else class="my-1 flex flex-col" :class="line.kind === 'outgoing' ? 'items-end' : 'items-start'">
                    <div
                        :data-testid="line.kind === 'outgoing' ? 'message-out' : 'message-in'"
                        class="max-w-[min(72%,640px)] rounded-2xl px-4 py-2 leading-relaxed whitespace-pre-wrap select-text wrap-anywhere"
                        :class="line.kind === 'outgoing' ? 'rounded-br-md bg-brand text-on-brand' : 'rounded-bl-md bg-bubble text-on-bubble'"
                    >
                        <span data-testid="message-text">{{ line.text }}</span>
                    </div>
                    <span class="mx-2 text-xs text-muted">{{ clock(line.at) }}</span>
                </div>
            </template>
        </div>

        <v-sheet class="flex flex-none items-end gap-2 border-t border-line p-3">
            <v-textarea
                v-model="draft"
                data-testid="composer"
                :placeholder="connected ? 'Write a message (Enter to send, Shift+Enter for a new line)' : `Not connected to ${conversation.name}. Click Connect to keep chatting.`"
                :disabled="!connected"
                rows="1"
                max-rows="6"
                auto-grow
                hide-details
                maxlength="16000"
                @keydown="onKeydown"
            />
            <v-btn
                data-testid="send"
                :icon="mdiSend"
                color="primary"
                :disabled="!connected || draft.trim() === ''"
                :loading="sending"
                @click="submit"
            />
        </v-sheet>
    </div>
</template>
