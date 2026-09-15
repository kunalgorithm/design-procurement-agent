import { motion } from 'framer-motion';
import type { Slots } from '@/components/landing-page/types';
import { cn } from '@/lib/utils';
import { useNavigate } from 'react-router';

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
  const navigate = useNavigate();
  const headerContent = data.items[0];
  const isVideo = headerContent.photosCollection?.items?.[0]?.contentType?.includes('video');
  const isSignupAction = headerContent.actionUrl === '/signup';

  return (
    <motion.div initial="hidden" animate="visible" variants={variants}>
      <div className={cn('flex w-full', { 'bg-black-700': isBlack }, className)}>
        <div className="grid w-full grid-cols-1 md:grid-cols-12">
          <div
            className={cn(
              'mx-10 flex max-w-lg flex-col place-self-center py-12 md:col-span-6 xl:mx-20',
              contentClassName,
            )}
          >
            {headerContent.description && (
              <p className={cn('mb-2 text-base text-black-700', { 'text-black-50': isBlack })}>
                {headerContent.description}
              </p>
            )}
            <h3 className={cn('leading-normal text-black-700 md:p-0', { 'text-white': isBlack })}>
              {headerContent.slotTitle.split('\n').map((line: string, i: number) => (
                <span key={i}>
                  {line}
                  {i < headerContent.slotTitle.split('\n').length - 1 && <br />}
                </span>
              ))}
            </h3>
            {renderDocument(headerContent.markdown?.json, !!isBlack)}
            {headerContent.actionText &&
              headerContent.actionUrl &&
              (isSignupAction ? (
                <button
                  onClick={() => navigate('/signup')}
                  className={cn(
                    'inline-flex items-center justify-center h-9 px-4 py-2 rounded-xs text-sm font-light capitalize transition-colors self-start',
                    isBlack
                      ? 'bg-secondary text-secondary-foreground hover:bg-secondary-hover focus-visible:bg-secondary-hover active:bg-secondary/90'
                      : 'bg-primary text-primary-foreground hover:bg-primary-hover focus-visible:bg-primary-hover active:bg-primary/90',
                  )}
                >
                  {headerContent.actionText}
                </button>
              ) : (
                <a
                  href={headerContent.actionUrl}
                  className={cn(
                    'inline-flex items-center justify-center h-9 px-4 py-2 rounded-xs text-sm font-light capitalize transition-colors self-start',
                    isBlack
                      ? 'bg-secondary text-secondary-foreground hover:bg-secondary-hover focus-visible:bg-secondary-hover active:bg-secondary/90'
                      : 'bg-primary text-primary-foreground hover:bg-primary-hover focus-visible:bg-primary-hover active:bg-primary/90',
                  )}
                >
                  {headerContent.actionText}
                </a>
              ))}
          </div>
          <div className={cn('w-full content-center md:col-span-6', { 'w-fit md:content-center': isVideo })}>
            {headerContent.photosCollection?.items[0]?.url && (
              <>
                {isVideo ? (
                  <video
                    autoPlay
                    loop
                    muted
                    className="w-full md:min-w-96 md:rounded-l-md md:shadow-lg md:shadow-black lg:max-h-[700px] lg:min-w-[550px]"
                    playsInline
                    src={headerContent.photosCollection.items[0].url}
                  >
                    <track kind="captions" />
                  </video>
                ) : (
                  <img
                    alt={headerContent.slotTitle}
                    className="aspect-9/10 max-h-[700px] w-full object-cover object-center lg:min-w-[600px] 2xl:object-center"
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
