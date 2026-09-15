import { useEffect } from 'react';
import { CONTRACTOR_LANDING_DATA } from '@/components/landing-page/landing-data-contractor';
import { ProjectQuestions } from '@/components/landing-page/ProjectQuestions';
import { ContractorTools, TextWorkflow } from '@/components/landing-page/ContractorTools';

import {
  BannerComponent,
  Footer,
  HeaderMediaComponent,
  HowItWorksCards,
  Navbar,
  SectionContent,
} from '@/components/landing-page';

export function HomePage() {
  const formDesignLandingData = CONTRACTOR_LANDING_DATA;
  useEffect(() => {
    document.title = 'FORM for Contractors — Win more kitchen jobs';
    document.querySelector('meta[name="description"]')?.setAttribute('content', 'Win more kitchen jobs. Spend less time on admin. Join the free FORM contractor pilot for kitchen design, estimates, and job admin by text.');
  }, []);

  return (
    <>
      <Navbar />
      <main style={{ backgroundColor: 'hsl(var(--black-50))' }}>
        <HeaderMediaComponent data={formDesignLandingData.items[0].contentSlotsCollection} isBlack />
        <BannerComponent className="mt-0" data={formDesignLandingData.items[1].contentSlotsCollection} />
        <ContractorTools />
        <HowItWorksCards data={formDesignLandingData.items[3].contentSlotsCollection} />
        <BannerComponent className="mt-0" data={formDesignLandingData.items[4].contentSlotsCollection} isBlack />
        <SectionContent
          className="mt-16 md:mt-24"
          contentClassName="bg-black-100"
          imgClassName="md:object-cover"
          data={formDesignLandingData.items[5].contentSlotsCollection}
        />
        <SectionContent
          className="mt-16 md:mt-24"
          contentClassName="bg-black-100"
          imgClassName="md:object-cover"
          data={formDesignLandingData.items[6].contentSlotsCollection}
        />
        <TextWorkflow />
        <ProjectQuestions />
        <div>
          <BannerComponent
            className="mt-16"
            contentClassName="text-base leading-7 font-thin mt-4"
            data={formDesignLandingData.items[10].contentSlotsCollection}
            showInColumns
            isBlack
          />
        </div>
      </main>
      <Footer />
    </>
  );
}

export default HomePage;
