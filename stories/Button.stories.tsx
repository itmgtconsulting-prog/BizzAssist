// @ts-expect-error — @storybook/react is not installed yet; run: npm install --save-dev @storybook/nextjs @storybook/addon-essentials @storybook/react
import type { Meta, StoryObj } from '@storybook/react';
import { Loader2 } from 'lucide-react';

// ─── Example component ────────────────────────────────────────────────────────

/**
 * A minimal dark-themed button that matches the BizzAssist design system.
 * This is an example component — in production use the shared Button component
 * from app/components/ui/ once it exists.
 *
 * @param variant   - Visual style: primary (blue) | secondary (slate) | danger (red)
 * @param size      - Size preset: sm | md | lg
 * @param loading   - Show a spinner and disable the button
 * @param disabled  - Disable without spinner
 * @param label     - Button text
 * @param onClick   - Click handler
 */
interface ButtonProps {
  /** Visual variant */
  variant?: 'primary' | 'secondary' | 'danger';
  /** Size preset */
  size?: 'sm' | 'md' | 'lg';
  /** Show loading spinner */
  loading?: boolean;
  /** Disable the button */
  disabled?: boolean;
  /** Button label */
  label: string;
  /** Click handler */
  onClick?: () => void;
}

const variantClasses: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-blue-600 hover:bg-blue-500 text-white disabled:bg-slate-700 disabled:text-slate-500',
  secondary:
    'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-600 disabled:opacity-40',
  danger: 'bg-red-700 hover:bg-red-600 text-white disabled:bg-slate-700 disabled:text-slate-500',
};

const sizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'px-3 py-1.5 text-xs rounded-md gap-1.5',
  md: 'px-4 py-2.5 text-sm rounded-lg gap-2',
  lg: 'px-6 py-3 text-base rounded-xl gap-2.5',
};

/**
 * BizzAssist dark-theme button — example Storybook component.
 */
function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  label,
  onClick,
}: ButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={[
        'inline-flex items-center justify-center font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900',
        variantClasses[variant],
        sizeClasses[size],
      ].join(' ')}
    >
      {loading && (
        <Loader2 size={size === 'lg' ? 18 : size === 'sm' ? 12 : 14} className="animate-spin" />
      )}
      {label}
    </button>
  );
}

// ─── Storybook meta ───────────────────────────────────────────────────────────

const meta: Meta<typeof Button> = {
  title: 'UI/Button',
  component: Button,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
    backgrounds: { default: 'dark' },
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary', 'secondary', 'danger'],
      description: 'Visual style variant',
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
      description: 'Size preset',
    },
    loading: { control: 'boolean' },
    disabled: { control: 'boolean' },
    label: { control: 'text' },
    onClick: { action: 'clicked' },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

// ─── Stories ──────────────────────────────────────────────────────────────────

/** Default primary button — the most common CTA in BizzAssist. */
export const Primary: Story = {
  args: {
    variant: 'primary',
    size: 'md',
    label: 'Gem ændringer',
  },
};

/** Secondary button used for cancel / back actions. */
export const Secondary: Story = {
  args: {
    variant: 'secondary',
    size: 'md',
    label: 'Annuller',
  },
};

/** Danger button for destructive actions (delete, revoke). */
export const Danger: Story = {
  args: {
    variant: 'danger',
    size: 'md',
    label: 'Slet element',
  },
};

/** Loading state — spinner shown, button disabled. */
export const Loading: Story = {
  args: {
    variant: 'primary',
    size: 'md',
    label: 'Gemmer…',
    loading: true,
  },
};

/** Disabled state without spinner. */
export const Disabled: Story = {
  args: {
    variant: 'primary',
    size: 'md',
    label: 'Ikke tilgængelig',
    disabled: true,
  },
};

/** Small size — used in table rows and compact UIs. */
export const Small: Story = {
  args: {
    variant: 'primary',
    size: 'sm',
    label: 'Tilføj',
  },
};

/** Large size — used in hero CTAs. */
export const Large: Story = {
  args: {
    variant: 'primary',
    size: 'lg',
    label: 'Kom i gang',
  },
};
