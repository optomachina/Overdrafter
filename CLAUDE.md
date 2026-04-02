@AGENTS.md

## Code Standards

- Always use TypeScript strict mode
- Do NOT use `any` type — use proper types or `unknown`
- Use named exports, not default exports
- Keep functions under 50 lines, break into smaller units if longer
- Do NOT use inline styles, always use Tailwind classes
- Follow the existing component structure in `apps/web/src/components`

## Testing Requirements

- Write tests for every new feature before marking task complete
- Run `npm test` after any changes to verify nothing breaks
- Never skip error handling, always wrap risky operations in try/catch

## API Conventions

- All API responses must match the `/types/api.ts` interfaces
- Use the `/lib/api-client.ts` wrapper, never raw fetch calls
- Always handle loading and error states in UI components

## Documentation

- Update README.md if you add new environment variables
- Add JSDoc comments to all exported functions
- Update `/docs/architecture.md` for any significant structural changes

## Performance Rules

- Lazy load components that aren't immediately visible
- Use React.memo for expensive re-renders
- Never fetch data in loops, batch requests instead
