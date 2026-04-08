// @ts-expect-error — @storybook/nextjs not installed yet; run: npm install --save-dev @storybook/nextjs @storybook/addon-essentials @storybook/react
import type { StorybookConfig } from '@storybook/nextjs';

/**
 * Storybook main configuration for BizzAssist.
 * Uses the @storybook/nextjs framework for full Next.js App Router compatibility.
 *
 * Stories are co-located in the `stories/` directory or alongside components
 * as `*.stories.tsx` files.
 */
const config: StorybookConfig = {
  /** Glob patterns that Storybook will scan for story files. */
  stories: ['../stories/**/*.stories.@(ts|tsx)', '../app/components/**/*.stories.@(ts|tsx)'],

  /** Core addons — interactions, controls, viewport, a11y. */
  addons: ['@storybook/addon-essentials', '@storybook/addon-interactions'],

  /** Next.js framework — handles Tailwind CSS, Image, Link, etc. */
  framework: {
    name: '@storybook/nextjs',
    options: {},
  },

  /** TypeScript transpilation settings. */
  typescript: {
    check: false,
    reactDocgen: 'react-docgen-typescript',
    reactDocgenTypescriptOptions: {
      shouldExtractLiteralValuesFromEnum: true,
      propFilter: (prop) => (prop.parent ? !/node_modules/.test(prop.parent.fileName) : true),
    },
  },

  /** Expose static files (public/) inside Storybook. */
  staticDirs: ['../public'],
};

export default config;
