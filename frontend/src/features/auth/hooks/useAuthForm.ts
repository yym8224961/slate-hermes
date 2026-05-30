import { useState } from 'react';
import { getApiErrorMessage } from '@/lib/api-errors';

export function useAuthForm() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function run(action: () => Promise<void>, fallbackError: string) {
    setError(null);
    setLoading(true);
    try {
      await action();
    } catch (err) {
      setError(getApiErrorMessage(err, fallbackError));
    } finally {
      setLoading(false);
    }
  }

  return { error, setError, loading, run };
}
