import { motion, useReducedMotion } from 'framer-motion';
import type { Slots } from '@/components/landing-page/types';
import { cn } from '@/lib/utils';
import { useNavigate } from 'react-router';
import { ArrowRight } from 'lucide-react';

interface HeaderProps {
  className?: string;
  contentClassName?: string;
  data: Slots;
  isBlack?: boolean;
}

const variants = {
  visible: {
    opacity: 1,
    y: 0,
    transition: { ease: 'easeOut' as const, delay: 0.25, duration: 0.75 },
  },
  hidden: { opacity: 0, y: 75 },
};

const renderDocument = (doc: any, isBlack: boolean) => {
  if (!doc) return null;
  return doc.content.map((para: any, idx: number) => (
    <p
      key={idx}
      className={cn('pb-9 pt-4 text-base leading-7 text-black-600', {
        'text-white sm:text-black-100': isBlack,
      })}
    >
      {para.content.map((text: any) => text.value).join('')}
    </p>
  ));
};

export const HeaderMediaComponent = ({ className, contentClassName, data, isBlack }: HeaderProps) => {
  const reducedMotion = useReducedMotion();
  const navigate = useNavigate();
  const headerContent = data.items[0];
  const isVideo = headerContent.photosCollection?.items?.[0]?.contentType?.includes('video');
  const isSignupAction = headerContent.actionUrl === '/signup';

  return (
    <motion.div initial={reducedMotion ? false : 'hidden'} animate="visible" variants={variants}>
      <div className={cn('flex w-full', { 'bg-black-700': isBlack }, className)}>
        <div className="form-container form-hero-grid">
          <div
            className={cn(
              'form-hero-copy flex min-w-0 flex-col',
              contentClassName,
            )}
          >
            {headerContent.description && (
              <p className={cn('form-hero-eyebrow mb-5 text-black-700', { 'text-black-50': isBlack })}>
                {headerContent.description}
              </p>
            )}
            <h1 className={cn('text-black-700', { 'text-white': isBlack })}>
              {headerContent.slotTitle.split('\n').map((line: string, i: number) => (
                <span key={i}>
                  {line}
                  {i < headerContent.slotTitle.split('\n').length - 1 && <br />}
                </span>
              ))}
            </h1>
            {renderDocument(headerContent.markdown?.json, !!isBlack)}
            {headerContent.actionText &&
              headerContent.actionUrl &&
              (isSignupAction ? (
                <button
                  onClick={() => navigate('/signup')}
                  className={cn(
                    'form-button self-start',
                    isBlack && 'form-button-light',
                  )}
                >
                  {headerContent.actionText}
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              ) : (
                <a
                  href={headerContent.actionUrl}
                  className={cn(
                    'form-button self-start',
                    isBlack && 'form-button-light',
                  )}
                >
                  {headerContent.actionText}
                  <ArrowRight size={18} aria-hidden="true" />
                </a>
              ))}
            {isSignupAction && <p className="form-hero-note">Get FORM’s number. Start with a photo and a text.</p>}
          </div>
          <div className="min-w-0 w-full">
            {headerContent.photosCollection?.items[0]?.url && (
              <>
                {isVideo ? (
                  <video
                    autoPlay
                    loop
                    muted
                    className="form-hero-image"
                    playsInline
                    src={headerContent.photosCollection.items[0].url}
                  >
                    <track kind="captions" />
                  </video>
                ) : (
                  <img
                    alt={headerContent.photosCollection.items[0].title}
                    className="form-hero-image"
                    src={headerContent.photosCollection.items[0].url}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
};
