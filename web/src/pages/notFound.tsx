import { useEffect } from 'react';
import { Link } from 'react-router';
import { Navbar } from '@/components/landing-page/Navbar';

export default function NotFoundPage() {
  useEffect(() => {
    document.title = 'Page not found — FORM';
    document.querySelector('meta[name="description"]')?.setAttribute('content', 'Return to FORM for kitchen design support in Messages.');
  }, []);
  return <>
    <Navbar />
    <main className="form-container py-24">
      <h1 className="max-w-2xl text-4xl leading-tight md:text-5xl">We couldn’t find that page.</h1>
      <p className="mt-6 max-w-xl leading-7">Head back to FORM to get design support for your next kitchen bid.</p>
      <Link className="form-button mt-8" to="/">Back to FORM</Link>
    </main>
  </>;
}
