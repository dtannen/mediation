import { registerProvider } from '../provider-registry';
import claudeProvider from './claude-provider';
import ollamaProvider from './ollama-provider';

export function registerBuiltInProviders(): void {
  registerProvider(claudeProvider);
  registerProvider(ollamaProvider);
}
