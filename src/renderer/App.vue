<script setup lang="ts">
import { mdiLockOutline } from "@mdi/js";
import { onMounted } from "vue";
import ConnectCard from "./components/ConnectCard.vue";
import ConversationList from "./components/ConversationList.vue";
import ConversationView from "./components/ConversationView.vue";
import SelfCard from "./components/SelfCard.vue";
import ServerCard from "./components/ServerCard.vue";
import { errorText, init, selectedConversation, state, toast } from "./store";

onMounted(() => {
    init().catch((err) => toast(`Failed to start: ${errorText(err)}`, "error"));
});
</script>

<template>
    <v-app>
        <v-navigation-drawer permanent :width="350">
            <div class="flex flex-col gap-3 p-3">
                <SelfCard />
                <ConnectCard />
                <ServerCard />
                <ConversationList />
            </div>
        </v-navigation-drawer>

        <v-main class="h-screen">
            <ConversationView v-if="selectedConversation" :conversation="selectedConversation" />
            <v-empty-state
                v-else
                :icon="mdiLockOutline"
                headline="End-to-end encrypted, peer to peer"
                text="Messages go straight to the other device and are encrypted end to end. Each conversation uses fresh keys that are never written to disk. Join a server, then connect to someone by fingerprint or find them by name."
                class="h-full"
            />
        </v-main>

        <v-snackbar-queue v-model="state.toasts" location="bottom end" :timeout="6000" closable />
    </v-app>
</template>
