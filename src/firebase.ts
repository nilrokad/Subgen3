import { initializeApp, getApps, getApp } from 'firebase/app';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  projectId: "gen-lang-client-0510882267",
  appId: "1:114839426602:web:f22678e0f109a75c329553",
  apiKey: "AIzaSyD4zNM2cGjGZdOOhhLIUjMbB6p_bPET_xk",
  authDomain: "gen-lang-client-0510882267.firebaseapp.com",
  storageBucket: "gen-lang-client-0510882267.firebasestorage.app",
  messagingSenderId: "114839426602"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const storage = getStorage(app);
