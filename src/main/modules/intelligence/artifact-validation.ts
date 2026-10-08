/** Schema diagnostics can echo private model-controlled keys or values. Keep them inside the adapter boundary. */
export function parseAdvisoryArtifact<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value)
  } catch {
    throw new Error('Advisory provider returned invalid structured output')
  }
}
