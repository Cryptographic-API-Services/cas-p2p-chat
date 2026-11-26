import "vuetify/styles";
import { createVuetify } from "vuetify";
import { aliases, mdi } from "vuetify/iconsets/mdi-svg";

// Components are imported on demand by vite-plugin-vuetify. Icons are @mdi/js SVG paths,
// bundled with the app, so nothing is fetched at runtime.
export const vuetify = createVuetify({
    icons: { defaultSet: "mdi", aliases, sets: { mdi } },
    theme: {
        defaultTheme: "system",
        themes: {
            light: { colors: { primary: "#2f6fde" } },
            dark: { colors: { primary: "#5b9bff" } },
        },
    },
    defaults: {
        VTextField: { variant: "outlined", density: "compact" },
        VTextarea: { variant: "outlined", density: "compact" },
        VCard: { variant: "outlined" },
    },
});
