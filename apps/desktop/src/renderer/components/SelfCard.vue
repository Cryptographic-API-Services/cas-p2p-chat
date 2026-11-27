<script setup lang="ts">
import { mdiCamera, mdiContentCopy, mdiDeleteOutline, mdiImagePlus } from "@mdi/js";
import { ref } from "vue";
import { copyText, setAvatar, state } from "../store";
import ProfileAvatar from "./ProfileAvatar.vue";

const picker = ref<HTMLInputElement | null>(null);
const saving = ref(false);

async function onPick(): Promise<void> {
    const input = picker.value;
    const file = input?.files?.[0];
    if (input) {
        // So choosing the same file again still fires "change".
        input.value = "";
    }
    if (file) {
        await change(file);
    }
}

async function change(file: File | null): Promise<void> {
    saving.value = true;
    try {
        await setAvatar(file);
    } finally {
        saving.value = false;
    }
}
</script>

<template>
    <v-card>
        <v-card-item>
            <template #prepend>
                <v-menu location="bottom start">
                    <template #activator="{ props: menu }">
                        <v-badge location="bottom end" color="primary" :icon="mdiCamera" offset-x="4" offset-y="4">
                            <v-btn
                                v-bind="menu"
                                icon
                                variant="text"
                                :size="60"
                                :loading="saving"
                                data-testid="avatar-button"
                                title="Change your photo"
                                aria-label="Change your photo"
                            >
                                <ProfileAvatar data-testid="self-avatar" :avatar="state.me?.avatar" :name="state.me?.name ?? ''" :size="56" />
                            </v-btn>
                        </v-badge>
                    </template>
                    <v-list density="compact">
                        <v-list-item :prepend-icon="mdiImagePlus" data-testid="avatar-upload" @click="picker?.click()">
                            {{ state.me?.avatar ? "Change photo…" : "Upload a photo…" }}
                        </v-list-item>
                        <v-list-item
                            v-if="state.me?.avatar"
                            :prepend-icon="mdiDeleteOutline"
                            data-testid="avatar-remove"
                            @click="change(null)"
                        >
                            Remove photo
                        </v-list-item>
                    </v-list>
                </v-menu>
                <input
                    ref="picker"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                    class="hidden"
                    data-testid="avatar-input"
                    @change="onPick"
                />
            </template>
            <v-card-title data-testid="self-name">{{ state.me?.name ?? "…" }}</v-card-title>
            <v-card-subtitle>This device</v-card-subtitle>
        </v-card-item>
        <v-card-text v-if="state.me">
            <p class="mb-3 text-xs leading-relaxed text-muted">
                Your photo is shown to people you chat with, sent inside the encrypted session. The server never sees it.
            </p>
            <div class="mb-1 text-xs text-muted">Your fingerprint</div>
            <v-btn
                block
                variant="tonal"
                class="h-auto justify-between py-2 normal-case"
                :append-icon="mdiContentCopy"
                title="Copy fingerprint"
                @click="copyText(state.me.fingerprint, 'Fingerprint')"
            >
                <span class="font-mono text-left leading-normal tracking-wide whitespace-normal" data-testid="self-fingerprint">
                    {{ state.me.fingerprint }}
                </span>
            </v-btn>
            <p class="mt-2 text-xs leading-relaxed text-muted">
                Share this so people can connect to you, and compare it in person or on a call to verify each other.
            </p>

            <v-alert
                v-if="state.me.keyProtection === 'none'"
                type="warning"
                variant="tonal"
                density="compact"
                class="mt-3"
                text="This system has no secure key storage, so your identity key, and the key to your saved contacts and messages, are stored unencrypted."
            />
        </v-card-text>
    </v-card>
</template>
