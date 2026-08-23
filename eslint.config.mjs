import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // This repository's whole purpose is that a declared type means what it
      // says. A cast is how that stops being true, so casts to `any` and
      // non-null assertions are errors rather than warnings here.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      // `_`-prefixed bindings are the convention here for values declared to
      // prove something at the type level (an exhaustiveness `never`, a shape
      // that must not compile) and deliberately never read.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
