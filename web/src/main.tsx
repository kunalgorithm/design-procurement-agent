import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import HomePage from '@/pages/index';
import ContractorSignupPage from '@/pages/contractorSignup';
import './index.css';

const queryClient = new QueryClient();
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/contractors" element={<HomePage />} />
        <Route path="/signup" element={<ContractorSignupPage />} />
        <Route path="*" element={<main><h1>Page not found</h1><Link to="/">Back to FORM</Link></main>} />
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>,
);
