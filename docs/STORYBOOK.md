# Storybook Setup — BizzAssist

Storybook is configured but the npm packages must be installed before first use.

## Installation

Run the following command from the project root:

```bash
npm install --save-dev \
  @storybook/nextjs \
  @storybook/addon-essentials \
  @storybook/addon-interactions \
  @storybook/react \
  @storybook/test
```

## Running Storybook

```bash
npm run storybook
```

Opens on http://localhost:6006

## Building Storybook (static export)

```bash
npm run build-storybook
```

Output is written to `storybook-static/`.

## Configuration

| File                    | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `.storybook/main.ts`    | Framework, addons, story glob patterns             |
| `.storybook/preview.ts` | Global decorators, dark background, viewport, a11y |

## Writing Stories

Stories live in `stories/` or alongside components as `*.stories.tsx`.

### Naming convention

```
stories/
  Button.stories.tsx        ← UI primitives
  ejendomme/
    PropertyMap.stories.tsx ← Feature components
```

### Story template

```tsx
import type { Meta, StoryObj } from '@storybook/react';
import MyComponent from '@/app/components/MyComponent';

const meta: Meta<typeof MyComponent> = {
  title: 'Feature/MyComponent',
  component: MyComponent,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<typeof MyComponent>;

export const Default: Story = {
  args: {
    /* props */
  },
};
```

## Design System

All stories use the BizzAssist dark theme:

- Background: `#0f172a` (slate-900)
- Accent: `#2563eb` (blue-600)
- No white backgrounds anywhere
