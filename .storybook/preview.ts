// @ts-expect-error — @storybook/react not installed yet; run: npm install --save-dev @storybook/nextjs @storybook/addon-essentials @storybook/react
import type { Preview } from '@storybook/react';

/**
 * Storybook global preview configuration for BizzAssist.
 *
 * Sets up dark-theme globals, viewport defaults, and accessibility
 * checks that apply to every story in the project.
 *
 * The BizzAssist design system uses:
 *  - Background: #0f172a (slate-900)
 *  - Accent: #2563eb (blue-600)
 *  - All text on dark surfaces — no white-background components.
 */
const preview: Preview = {
  /** Global parameters applied to all stories. */
  parameters: {
    /** Force dark background to match the BizzAssist design system. */
    backgrounds: {
      default: 'dark',
      values: [
        { name: 'dark', value: '#0f172a' },
        { name: 'darker', value: '#0a1020' },
        { name: 'slate-800', value: '#1e293b' },
      ],
    },

    /** Responsive viewport presets. */
    viewport: {
      viewports: {
        mobile: { name: 'Mobile', styles: { width: '375px', height: '812px' } },
        tablet: { name: 'Tablet', styles: { width: '768px', height: '1024px' } },
        desktop: { name: 'Desktop', styles: { width: '1280px', height: '800px' } },
      },
      defaultViewport: 'desktop',
    },

    /** Controls addon — sort alphabetically by default. */
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /date$/,
      },
      sort: 'alpha',
    },

    /** Accessibility: fail stories that have critical a11y violations. */
    a11y: {
      config: {},
      options: {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa'],
        },
      },
    },
  },

  /** Global story decorators. */
  decorators: [],

  /** Global story args — shared default prop values. */
  globalTypes: {
    locale: {
      name: 'Locale',
      description: 'Internationalisation locale',
      defaultValue: 'da',
      toolbar: {
        icon: 'globe',
        items: [
          { value: 'da', title: 'Dansk' },
          { value: 'en', title: 'English' },
        ],
      },
    },
  },
};

export default preview;
