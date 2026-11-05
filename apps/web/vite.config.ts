import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.CROSSFARE_API_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/v1": api, "/demo": api, "/.well-known": api },
  },
});
