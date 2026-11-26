<script setup lang="ts">
import { open, shortFingerprint, sortedConversations, state } from "../store";
import TrustChip from "./TrustChip.vue";
</script>

<template>
    <div>
        <div class="mb-1 px-2 text-[11px] font-semibold tracking-wider text-muted uppercase">Contacts</div>
        <v-list v-if="sortedConversations.length > 0" nav density="compact" class="p-0">
            <v-list-item
                v-for="conversation in sortedConversations"
                :key="conversation.fingerprint"
                data-testid="conversation"
                :data-name="conversation.name"
                :active="conversation.fingerprint === state.selected"
                color="primary"
                @click="open(conversation.fingerprint)"
            >
                <v-list-item-title :class="{ 'text-muted': !conversation.peer }">
                    {{ conversation.name }}
                </v-list-item-title>
                <v-list-item-subtitle>
                    <span class="font-mono">{{ shortFingerprint(conversation.fingerprint) }}</span>
                    · {{ conversation.peer ? "connected" : "not connected" }}
                </v-list-item-subtitle>
                <template #append>
                    <v-badge v-if="conversation.unread > 0" :content="conversation.unread" color="primary" inline />
                    <TrustChip v-else :trust="conversation.trust" :disconnected="!conversation.peer" />
                </template>
            </v-list-item>
        </v-list>
        <p v-else class="px-2 text-xs leading-relaxed text-muted">
            Everyone you connect to is remembered here, on this device only.
        </p>
    </div>
</template>
