import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextVitals,
  ...nextTypeScript,
  {
    ignores: [".next/**", "drizzle/**", "next-env.d.ts", ".sandcastle/**", ".agents/**", ".claude/**", "data/**"],
  },
];

export default eslintConfig;
