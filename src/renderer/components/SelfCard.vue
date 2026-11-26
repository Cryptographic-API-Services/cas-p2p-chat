<script setup lang="ts">
import { mdiAccountCircleOutline, mdiContentCopy } from "@mdi/js";
import { copyText, state } from "../store";
</script>

<template>
    <v-card>
        <v-card-item :prepend-icon="mdiAccountCircleOutline">
            <v-card-title data-testid="self-name">{{ state.me?.name ?? "…" }}</v-card-title>
            <v-card-subtitle>This device</v-card-subtitle>
        </v-card-item>
        <v-card-text v-if="state.me">
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
                text="This system has no secure key storage, so your identity key is saved unencrypted."
            />
        </v-card-text>
    </v-card>
</template>
