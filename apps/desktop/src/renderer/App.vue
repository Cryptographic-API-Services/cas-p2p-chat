<script setup lang="ts">
import { mdiLockOutline } from "@mdi/js";
import { onMounted, ref } from "vue";
import { useDisplay } from "vuetify";
import ConnectCard from "./components/ConnectCard.vue";
import ConversationList from "./components/ConversationList.vue";
import ConversationView from "./components/ConversationView.vue";
import ProfileAvatar from "./components/ProfileAvatar.vue";
import SelfCard from "./components/SelfCard.vue";
import ServerCard from "./components/ServerCard.vue";
import { errorText, init, selectedConversation, state, toast } from "./store";

const { mdAndUp } = useDisplay();
/**
 * The sidebar, opened and closed from the app bar. In a wide window it starts open beside the
 * chat; in a narrow one it starts closed and opens over it.
 */
const drawer = ref(mdAndUp.value);

onMounted(() => {
    init().catch((err) => toast(`Failed to start: ${errorText(err)}`, "error"));
});
</script>

<template>
    <v-app>
        <v-app-bar color="primary" density="comfortable" flat>
            <v-app-bar-nav-icon
                data-testid="nav-toggle"
                variant="text"
                :title="drawer ? 'Hide the sidebar' : 'Show the sidebar'"
                @click.stop="drawer = !drawer"
            />
            <v-app-bar-title>CAS P2P Chat</v-app-bar-title>
            <template #append>
                <v-btn v-if="state.me" icon variant="text" title="Your profile" class="mr-1" @click="drawer = true">
                    <ProfileAvatar :avatar="state.me.avatar" :name="state.me.name" :size="34" color="white" />
                </v-btn>
            </template>
        </v-app-bar>

        <v-navigation-drawer v-model="drawer" :temporary="!mdAndUp" :width="350" data-testid="drawer">
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
