import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiUrl = process.env.API_URL ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT ?? 5173),
    proxy: {
      "/api": apiUrl,
      "/health": apiUrl,
    },
  },
});
