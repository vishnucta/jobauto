import "server-only";

// Every job type, so the runner knows them all whatever started a job, even
// after a restart. Import each module that calls defineJob() here.
import "./read-posting";
import "./write-documents";
import "./regenerate-unit";
import "./refine";
import "./write-email";
import "./translate-documents";
import "./write-document";
import "./score-resume";
import "./zip-pdfs";
import "./import-profile";
import "./draft-reply";
import "@/lib/agent/jobs";
import "@/lib/agent/draft";
import "./score-posting";
import "@/lib/startups/refresh";
import "@/lib/careers/check";
import "@/lib/connector/draft";
import "./apply";
import "./prepare-call";
