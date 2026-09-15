import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { FormLogo } from '@/components/ui/FormLogo';

export const Footer = () => (
  <footer className="bg-black-700 text-white">
    <div className="form-container flex flex-col gap-8 border-t border-white/20 py-10 md:flex-row md:items-center md:justify-between">
      <div>
        <Link to="/" aria-label="FORM for Contractors home"><FormLogo white size={112} /></Link>
        <p className="mt-3 text-sm text-white/70">Design, estimates, and job admin by text. A free contractor pilot.</p>
        <p className="mt-2 text-xs text-white/60">FORM © {new Date().getFullYear()}</p>
      </div>
      <div>
        <p className="mb-3 text-xs text-white/60">Previous FORM Kitchens work</p>
        <a className="text-sm underline underline-offset-4" href="https://www.houzz.com/professionals/kitchen-and-bath-designers/form-kitchens-pfvwus-pf~380822624" target="_blank" rel="noopener noreferrer">Explore the project archive</a>
      </div>
      <Link className="form-button form-button-light self-start md:self-auto" to="/signup">Get design support for my next bid <ArrowRight size={16} aria-hidden="true" /></Link>
    </div>
  </footer>
);
