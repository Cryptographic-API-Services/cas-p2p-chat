// app.css comes first: it declares the CSS layer order for Tailwind and Vuetify.
import "./app.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";
import { createApp } from "vue";
import App from "./App.vue";
import { vuetify } from "./plugins/vuetify";

createApp(App).use(vuetify).mount("#app");
