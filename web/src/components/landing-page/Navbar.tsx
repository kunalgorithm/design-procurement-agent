import { Link } from 'react-router';
import { FormLogo } from '@/components/ui/FormLogo';
import { ArrowRight } from 'lucide-react';

export function Navbar() {
  return (
    <nav className="sticky top-0 z-50 bg-white border-b border-gray-200" aria-label="Main navigation">
      <div className="form-container form-navbar-inner">
        <div className="form-brand">
          <Link to="/" aria-label="FORM home"><FormLogo size={112} /></Link>
          <span className="form-brand-label">FOR CONTRACTORS</span>
        </div>
        <Link className="form-button" to="/signup">Get started <ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
    </nav>
  );
}
