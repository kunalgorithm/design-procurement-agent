import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import type { Slots } from '@/components/landing-page/types';

interface SectionContentProps {
  className?: string;
  contentClassName?: string;
  imgClassName?: string;
  data: Slots;
}

const variants = {
  visible: {
    opacity: 1,
    y: 0,
    transition: { ease: 'easeOut' as const, delay: 0.25, duration: 0.75 },
  },
  hidden: { opacity: 0, y: 75 },
};

const renderDocument = (doc: any) => {
  if (!doc) return null;
  return doc.content.map((para: any, idx: number) => (
    <p key={idx} className="mt-4 text-base font-light leading-7 text-black-700 md:mt-10">
      {para.content.map((text: any) => text.value).join('')}
    </p>
  ));
};

export const SectionContent = ({ className, contentClassName, imgClassName, data }: SectionContentProps) => {
  const reducedMotion = useReducedMotion();
  const sectionContent = data.items?.[0];
  const isVideo = sectionContent.photosCollection?.items?.[0]?.contentType?.includes('video');

  return (
    <motion.div
      initial={reducedMotion ? false : 'hidden'}
      animate="visible"
      variants={variants}
      className={className}
    >
      <div
        className={cn('form-container flex flex-col md:flex-row', {
          'md:flex-row-reverse': !!sectionContent.isLeft,
        })}
      >
        <div
          className={cn(
            'flex w-full min-w-0 flex-col justify-center px-6 py-10 md:w-1/2 md:p-10 lg:p-16',
            contentClassName,
          )}
        >
          <h2 className="text-2xl leading-tight text-black-700 md:text-3xl">{sectionContent.slotTitle}</h2>
          {renderDocument(sectionContent.markdown?.json)}
          {sectionContent.actionText && sectionContent.actionUrl && (
            <div className="mt-14">
              <a
                href={sectionContent.actionUrl}
                className="form-button"
              >
                {sectionContent.actionText}
              </a>
            </div>
          )}
        </div>
        <div className="min-w-0 w-full md:w-1/2">
          {sectionContent.photosCollection?.items?.[0] && (
            <>
              {isVideo ? (
                <video
                  autoPlay
                  loop
                  muted
                  playsInline
                  src={sectionContent.photosCollection.items[0].url}
                  className={cn('h-full w-full', imgClassName)}
                >
                  <track kind="captions" />
                </video>
              ) : (
                <img
                  loading="lazy"
                  src={sectionContent.photosCollection.items[0].url}
                  alt={sectionContent.photosCollection.items[0].title}
                  className={cn('aspect-[9/10] w-full object-cover object-center md:object-contain', imgClassName)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
};
