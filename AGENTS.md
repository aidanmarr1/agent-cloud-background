# Project Rules

## UI Styling
- Do NOT use CSS gradients (bg-gradient-to-*, linear-gradient, etc.) — use flat solid colors instead.
- When iterating on existing UI, preserve the app's current visual language unless the user explicitly asks for a different direction.
- Before changing UI, inspect nearby screens/components and reuse existing design tokens, Tailwind patterns, component structure, spacing rhythm, typography, border radius, shadows, icon style, hover/focus states, and responsive behavior.
- Prefer extending or composing existing components over inventing new one-off styles. New UI should feel like it was already part of the app.
- Keep changes scoped to the requested surface. Do not introduce unrelated redesigns, decorative effects, new palettes, or layout conventions without user approval.
