import "vuetify/styles";
import { createVuetify } from "vuetify";
import { aliases, mdi } from "vuetify/iconsets/mdi-svg";

// Components are imported on demand by vite-plugin-vuetify. Icons are @mdi/js SVG paths,
// bundled with the app, so nothing is fetched at runtime.
export const vuetify = createVuetify({
    icons: { defaultSet: "mdi", aliases, sets: { mdi } },
    theme: {
        defaultTheme: "system",
        // Palette taken from the project's GitHub avatar: a teal backdrop, a cyan-lit hand and
        // a deep navy wrist. Text on every pairing below meets WCAG AA (4.5:1) or better.
        themes: {
            light: {
                colors: {
                    primary: "#017a8f", // deep teal (backdrop, darkened for white text)
                    secondary: "#0a2a6e", // royal navy (fingertips)
                    accent: "#12b2ca", // bright teal
                    info: "#0499b0",
                    background: "#f2fafb", // teal-tinted white
                    surface: "#ffffff",
                    "on-background": "#0d2236",
                    "on-surface": "#0d2236",
                },
            },
            dark: {
                colors: {
                    primary: "#2cc4d8", // glowing cyan (the lit hand)
                    "on-primary": "#021942",
                    secondary: "#55c3e6", // palm highlight
                    "on-secondary": "#021942",
                    accent: "#00afc0",
                    info: "#12b2ca",
                    background: "#06122b", // near-black navy (wrist)
                    surface: "#0a1b39", // navy (wrist band)
                    "on-background": "#e3f2f6",
                    "on-surface": "#e3f2f6",
                },
            },
        },
    },
    defaults: {
        VTextField: { variant: "outlined", density: "compact" },
        VTextarea: { variant: "outlined", density: "compact" },
        VCard: { variant: "outlined" },
    },
});
