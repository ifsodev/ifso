/**
 * Home view — a Server Component.
 *
 * Sections are built as client leaves so this view stays a Server Component
 * (hard rule #6). The fixed header sits over everything; the story (blocks
 * 1-9) is one run of pinned, scroll-scrubbed scenes; contact (block 10)
 * closes the page. `isolate` keeps the scenes' stacking order inside <main>,
 * under the header, the cookie banner and the CRT overlay.
 */
import { headerContent, heroContent, preloaderContent } from "@/data/home/intro";
import {
  skylineSequence,
  studentSequence,
  windowSequence,
} from "@/data/home/sequences";
import {
  cloudPassContent,
  contactContent,
  processContent,
  studioContent,
  whatWeMakeContent,
  wipeContent,
  worksContent,
} from "@/data/home/story";
import { HydrateWhenIdle } from "@/components/common/hydrate-when-idle";
import { RobotProvider, RobotView } from "@/components/common/robot-view";
import { Contact } from "@/views/home/contact";
import { HomeStory } from "@/views/home/home-story";
import { SiteHeader } from "@/views/home/site-header";

export interface HomeViewProps {
  /**
   * The robot form (D-016, `app/robot-view`): no preloader, every entrance at
   * rest in the served HTML, each scrubbed sequence a still of its first frame.
   */
  robot?: boolean;
}

export const HomeView = ({ robot = false }: HomeViewProps) => {
  return (
    <RobotProvider robot={robot}>
      {robot && <RobotView />}
      <SiteHeader content={headerContent} />
      <main id="top" className="isolate">
        <HomeStory
          preloader={preloaderContent}
          hero={heroContent}
          studio={studioContent}
          wipe={wipeContent}
          whatWeMake={whatWeMakeContent}
          cloudPass={cloudPassContent}
          process={processContent}
          works={worksContent}
          sequences={{
            skyline: skylineSequence,
            student: studentSequence,
            window: windowSequence,
          }}
        />
        {/* The page's last screen: hydrated in an idle period after load. */}
        <HydrateWhenIdle>
          <Contact content={contactContent} />
        </HydrateWhenIdle>
      </main>
    </RobotProvider>
  );
};
