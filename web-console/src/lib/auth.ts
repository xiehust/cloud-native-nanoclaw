import { useState, useEffect, useCallback } from 'react';
import { fetchAuthSession, signIn, signOut, signUp, getCurrentUser } from 'aws-amplify/auth';

interface AuthUser {
  userId: string;
  email: string;
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkUser();
  }, []);

  async function checkUser() {
    try {
      const currentUser = await getCurrentUser();
      const session = await fetchAuthSession();
      setUser({
        userId: currentUser.userId,
        email: currentUser.signInDetails?.loginId || '',
      });
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  const login = useCallback(async (email: string, password: string) => {
    await signIn({ username: email, password });
    await checkUser();
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    await signUp({ username: email, password, options: { userAttributes: { email } } });
  }, []);

  const logout = useCallback(async () => {
    await signOut();
    setUser(null);
  }, []);

  return { user, loading, login, register, logout };
}

// Get JWT for API calls
export async function getAuthToken(): Promise<string> {
  const session = await fetchAuthSession();
  return session.tokens?.accessToken?.toString() || '';
}
