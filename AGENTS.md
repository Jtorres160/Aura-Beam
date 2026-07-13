<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Aura Engineering Guide

## Product

Aura is an AI-powered trading card scanner and collection platform for:

- Magic: The Gathering
- Pokémon
- Yu-Gi-Oh!

Aura is built for collectors.

The goal is not to be an AI demo or a generic card scanner. The goal is to become the most trusted collector instrument for identifying, valuing, and managing trading cards.

Every engineering decision should increase collector trust.

---

# Core Philosophy

## AI is a sensor, not the judge.

Vision models provide evidence.

Deterministic systems determine truth.

Never design a system where AI is the final authority.

Whenever possible:

Evidence → Verification → Decision

NOT:

AI Guess → User

Accuracy is more valuable than confidence.

If evidence is insufficient, the correct behavior is uncertainty—not hallucination.

---

# Scanner Architecture

The scanner follows this pipeline:

Camera
↓
Capture Pipeline
↓
Vision / OCR Extraction
↓
Evidence Layer
↓
Candidate Generation
↓
Evidence Scoring
↓
Decision Gate
↓
Result

Responsibilities must stay separated.

Camera code should never contain scoring logic.

Scoring should never perform OCR.

Decision gates should never extract evidence.

Maintain clean boundaries between stages.

---

# Scanner Principles

When debugging recognition:

Never begin by changing prompts.

Never begin by increasing AI confidence.

Instead investigate:

1. Capture quality
2. OCR extraction
3. Evidence completeness
4. Candidate generation
5. Candidate ranking
6. Evidence scoring
7. Decision thresholds

Classification of failures:

- Capture failure
- Extraction failure
- Candidate failure
- Scoring failure
- Decision failure

Every scanner issue should fit one of these categories.

---

# Evidence Philosophy

Evidence strength is roughly:

Very Strong
- Collector number
- Set code
- Exact card name
- Artwork verification

Strong
- Mana cost
- HP
- Attack
- Card type

Supporting
- Rules text
- Layout
- Symbols
- Colors

Weak
- Overall appearance
- General theme

Multiple strong pieces of evidence should outweigh one uncertain AI prediction.

---

# Engineering Principles

Before writing code:

- Understand the existing implementation.
- Search for existing patterns.
- Preserve architecture.
- Prefer extending existing systems over creating parallel systems.
- Make the smallest correct change.

Avoid:

- Duplicate logic
- Hidden side effects
- Large rewrites without evidence
- Temporary hacks becoming permanent

Favor readable code over clever code.

---

# Code Review Standards

Every review should consider:

Correctness
- Does it actually solve the problem?

Architecture
- Is the logic in the correct layer?

Performance
- Can work be reduced?
- Are expensive operations repeated?

Reliability
- What happens on failures?
- Are edge cases handled?

Security
- Are inputs validated?
- Are secrets protected?

Maintainability
- Is the intent obvious?
- Is the code easy to extend?

---

# Product Philosophy

Aura should feel like:

- a collector instrument
- a museum archive
- a precision tool

Not:

- a chatbot
- an AI toy
- a flashy dashboard
- a generic SaaS application

Trust is the product.

---

# Design Language

Design should communicate precision.

Use:

- warm neutral palette
- brass accent color
- editorial typography
- restrained motion
- premium spacing
- museum-quality presentation

Avoid:

- glassmorphism
- neon gradients
- glowing AI visuals
- excessive animation
- clutter
- generic dashboard aesthetics

---

# User Experience Principles

Collectors should immediately understand:

What card this is.

Why Aura believes it.

How confident the system is.

What evidence supports the decision.

Never hide uncertainty.

Explain uncertainty when appropriate.

---

# Database Principles

Collection data is a source of truth.

Never fabricate analytics.

Never generate fake trends.

Never estimate values without identifying them as estimates.

Historical data should always come from stored history, not simulated values.

---

# Performance Principles

Optimize where users notice:

- scanner responsiveness
- camera startup
- candidate generation
- search speed
- collection loading

Avoid premature optimization elsewhere.

Measure before optimizing.

---

# Development Workflow

Before implementing a feature:

Understand the problem.

Understand the existing implementation.

Identify affected systems.

Estimate risks.

Implement.

Verify.

Refactor only when justified.

---

# Current Technology

Frontend
- Next.js App Router
- React
- TypeScript

Backend
- Prisma
- PostgreSQL

AI
- OpenAI Vision

Card Data
- Scryfall
- Pokémon data sources
- Yu-Gi-Oh! data sources

Deployment
- Vercel

---

# Available Specialist Roles

When appropriate, adopt one of these specialist perspectives.

Aura Core Engineer
- Architecture
- Refactoring
- Reliability
- APIs
- Database integrity
- Performance

Aura Scanner Scientist
- OCR
- Vision
- Candidate generation
- Evidence extraction
- Scoring
- Matching accuracy

Aura Product Director
- UX
- Product strategy
- Collector psychology
- Feature evaluation
- Retention
- Premium experience

---

# Final Principle

Aura succeeds when collectors trust it.

Every decision should move the product toward:

Higher accuracy.

Higher transparency.

Higher reliability.

Higher trust.

When forced to choose between looking impressive and being correct, always choose being correct.