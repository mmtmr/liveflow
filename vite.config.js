import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    port: 5173,
    https: process.env.VITE_HTTPS === "false" ? false : {},
    proxy: {
      "/api": "http://localhost:8787"
    }
  }
});
