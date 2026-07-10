import { useState, useEffect } from 'react';
import '@src/Options.css';
import { withErrorBoundary, withSuspense } from '@extension/shared';
import { ModelSettings } from './components/ModelSettings';

const Options = () => {
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Check for dark mode preference
  useEffect(() => {
    const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    setIsDarkMode(darkModeMediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsDarkMode(e.matches);
    };

    darkModeMediaQuery.addEventListener('change', handleChange);
    return () => darkModeMediaQuery.removeEventListener('change', handleChange);
  }, []);

  return (
    <div
      className={`flex min-h-screen justify-center ${isDarkMode ? 'bg-slate-900' : "bg-[url('/bg.jpg')] bg-cover bg-center"} ${isDarkMode ? 'text-gray-200' : 'text-gray-900'}`}>
      <main className={`m-8 w-full max-w-xl rounded-xl ${isDarkMode ? 'bg-slate-800/80' : 'bg-white/80'} p-8 backdrop-blur-sm`}>
        <h1 className={`mb-6 text-xl font-bold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>Settings</h1>
        <ModelSettings isDarkMode={isDarkMode} />
      </main>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Options, <div>Loading...</div>), <div>Error Occurred</div>);
