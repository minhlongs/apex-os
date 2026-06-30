# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Claude-Zenos Unified Launcher** - Unified launcher integrating Claude Code with ZenOS branding and LM Studio model selection
- **Cloudflare D1 Migration** - Complete migration to Cloudflare D1 with type checking fixes and local development support
- **OPC Platform Dev Environment** - Bootstrap script for initializing opc-community-platform development environment
- **Production Readiness Verification Script** - Automated script to verify production deployment readiness
- **Global Auto-Routing for Claude Code** - Intelligent model routing system with LM Studio integration and proper TTY handling
- **Mekong Furniture OPC Automation System** - Complete automation system for Mekong Furniture OPC operations

### Changed
- **Auto-Routing Rewrite** - Complete rewrite of ck-init auto-routing with improved TTY handling
- **Project Status** - Marked project as complete with mainnet deployment deferred

### Fixed
- **Skill.py and Setup Verification** - Fixed verify-setup arithmetic issues and added missing skill.py

### Documentation
- **Claude-Zenos Unified Launcher Documentation** - Comprehensive documentation for the unified launcher
- **Ship Pipeline Documentation** - Added ship pipeline documentation and scripts
- **Production Deployment Quick Reference** - Quick reference guide for production deployment
- **Handover Package** - Urgent handover package for immediate production deployment
- **Claude Code Integration Guide** - Integration guide for auto-routing configuration
- **Production Deployment Checklist** - Setup guide and checklist for production deployment
- **Progress Checklist for Init Workflow** - Detailed progress tracking for initialization workflow

## [1.0.1] - 2026-06-25

### Added
- **Analytics Integration** - Full analytics integration across the platform
- **OKX/KuCoin Webhook Support** - Webhook support for OKX and KuCoin exchanges
- **131 Test Fixes** - Comprehensive test suite improvements and fixes
- **Lint Cleanup** - Code quality improvements through linting cleanup

### Changed
- **Phase 0-1 Completion** - Marked Phase 0-1 as complete with all core features implemented

## [1.0.0] - 2026-06-22

### Added
- **Production Ready Release** - ApexOS is now production ready
- **OpenNext Routes Configuration** - Configured OpenNext routes for optimal performance
- **Staging Seed Data** - Added seed data for staging environment
- **Multisig Treasury Implementation** - Complete multisig wallet implementation
- **Gas Oracle Integration** - Gas price oracle for transaction fee estimation
- **Batch Builder** - Transaction batch builder for efficiency
- **VietAPI Optimization Scripts** - Optimization scripts for VietAPI integration

### Changed
- **Project Status** - Official production ready status with full deployment capability

---

## Version Format

- **Major versions (x.0.0)**: Breaking changes, new architectures, production readiness milestones
- **Minor versions (0.x.0)**: New features, significant improvements, phase completions
- **Patch versions (0.0.x)**: Bug fixes, documentation updates, test improvements

## Release Categories

- **Production Releases**: Marked with `chore(release)` commits, represent official releases
- **Feature Releases**: Marked with `feat:` commits, add new functionality
- **Maintenance Releases**: Marked with `chore:` commits, infrastructure and tooling updates
- **Documentation Releases**: Marked with `docs:` commits, documentation improvements
- **Bug Fix Releases**: Marked with `fix:` commits, bug fixes and stability improvements
