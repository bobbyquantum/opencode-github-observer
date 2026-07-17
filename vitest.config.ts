import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          include: ["packages/shared/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "worker",
          include: ["packages/worker/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "daemon",
          include: ["packages/daemon/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "cli",
          include: ["packages/cli/test/**/*.test.ts"],
        },
      },
    ],
  },
});
