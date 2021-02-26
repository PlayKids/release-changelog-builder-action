import {Octokit} from '@octokit/rest'
import {Commits, CommitInfo} from './commits'
import {PullRequestInfo, PullRequests} from './pullRequests'
import {buildChangelog} from './transform'
import * as core from '@actions/core'
import {Configuration, DefaultConfiguration} from './configuration'
import {failOrError} from './utils'
import * as crypto from 'crypto'

export interface ReleaseNotesOptions {
  owner: string // the owner of the repository
  repo: string // the repository
  fromTag: string // the tag/ref to start from
  toTag: string // the tag/ref up to
  failOnError: boolean // defines if we should fail the action in case of an error
  commitMode: boolean // defines if we use the alternative commit based mode. note: this is only partially supported
  configuration: Configuration // the configuration as defined in `configuration.ts`
}

export class ReleaseNotes {
  constructor(private octokit: Octokit, private options: ReleaseNotesOptions) {}

  async pull(): Promise<string | null> {
    const {configuration} = this.options

    let mergedPullRequests: PullRequestInfo[]
    if (!this.options.commitMode) {
      core.startGroup(`🚀 Load pull requests`)
      mergedPullRequests = await this.getMergedPullRequests(this.octokit)
      core.endGroup()
    } else {
      core.startGroup(`🚀 Load commit history`)
      core.info(`⚠️ Executing experimental commit mode`)
      mergedPullRequests = await this.generateCommitPRs(this.octokit)
      core.endGroup()
    }

    if (mergedPullRequests.length === 0) {
      core.warning(`⚠️ No pull requests found`)
      return null
    }

    core.startGroup('📦 Build changelog')
    const resultChangelog = buildChangelog(
      mergedPullRequests,
      configuration,
      this.options
    )
    core.endGroup()
    return resultChangelog
  }

  private async getCommitHistory(octokit: Octokit): Promise<CommitInfo[]> {
    const {owner, repo, fromTag, toTag, failOnError} = this.options
    core.info(`ℹ️ Comparing ${owner}/${repo} - '${fromTag}...${toTag}'`)

    const commitsApi = new Commits(octokit)
    let commits: CommitInfo[]
    try {
      commits = await commitsApi.getDiff(owner, repo, fromTag, toTag)
    } catch (error) {
      failOrError(
        `💥 Failed to retrieve - Invalid tag? - Because of: ${error}`,
        failOnError
      )
      return []
    }
    if (commits.length === 0) {
      core.warning(`⚠️ No commits found between - ${fromTag}...${toTag}`)
      return []
    }

    return commits
  }

  private async getMergedPullRequests(
    octokit: Octokit
  ): Promise<PullRequestInfo[]> {
    const {owner, repo, configuration} = this.options

    const commits = await this.getCommitHistory(octokit)
    if (commits.length === 0) {
      return []
    }

    const firstCommit = commits[0]
    const lastCommit = commits[commits.length - 1]
    let fromDate = firstCommit.date
    const toDate = lastCommit.date

    const maxDays =
      configuration.max_back_track_time_days ||
      DefaultConfiguration.max_back_track_time_days
    const maxFromDate = toDate.clone().subtract(maxDays, 'days')
    if (maxFromDate.isAfter(fromDate)) {
      core.info(`⚠️ Adjusted 'fromDate' to go max ${maxDays} back`)
      fromDate = maxFromDate
    }

    core.info(
      `ℹ️ Fetching PRs between dates ${fromDate.toISOString()} to ${toDate.toISOString()} for ${owner}/${repo}`
    )

    const pullRequestsApi = new PullRequests(octokit)
    const pullRequests = await pullRequestsApi.getBetweenDates(
      owner,
      repo,
      fromDate,
      toDate,
      configuration.max_pull_requests || DefaultConfiguration.max_pull_requests
    )

    core.info(
      `ℹ️ Retrieved ${pullRequests.length} merged PRs for ${owner}/${repo}`
    )

    const prCommits = pullRequestsApi.filterCommits(
      commits,
      configuration.exclude_merge_branches ||
        DefaultConfiguration.exclude_merge_branches
    )

    core.info(
      `ℹ️ Retrieved ${prCommits.length} release commits for ${owner}/${repo}`
    )

    if (configuration.use_metadata_hash) {
      core.info(
        `Metadata hash configuration is enabled. Using metadata hash to compare values`
      )
    }

    // create array of commits for this release
    const releaseCommitHashes = prCommits.map(commmit => {
      if (configuration.use_metadata_hash) {
        const metadataHash = this.generateMetadataHash(commmit)

        core.info(
          `Generating commit info from commit.metadataHash: ${metadataHash} | commmit.sha: ${
            commmit.sha
          } | commmit.summary: ${commmit.summary} | commmit.message: ${
            commmit.message
          } | commmit.author: ${
            commmit.author
          } | commmit.date: ${commmit.date.unix().toString()}`
        )

        return metadataHash
      }

      return commmit.sha
    })

    // return only the pull requests associated with this release
    return pullRequests.filter(pr => {
      if (configuration.use_metadata_hash) {
        const commit = this.createCommitInfo(pr)
        const metadataHash2 = this.generateMetadataHash(commit)
        core.info(
          `Generating commit info from pr. metadataHash2: ${metadataHash2} | pr.mergeCommitSha: ${
            pr.mergeCommitSha
          } | pr.mergeCommitSummary: ${
            pr.mergeCommitSummary
          } | pr.mergeCommitMessage: ${
            pr.mergeCommitMessage
          } | pr.mergeCommitAuthor: ${
            pr.mergeCommitAuthor
          } | pr.mergeCommitDate: ${pr.mergeCommitDate.unix().toString()}`
        )

        return releaseCommitHashes.includes(metadataHash2)
      }

      return releaseCommitHashes.includes(pr.mergeCommitSha)
    })
  }

  private createCommitInfo(pr: PullRequestInfo): CommitInfo {
    return {
      sha: pr.mergeCommitSha,
      summary: pr.mergeCommitSummary,
      message: pr.mergeCommitMessage,
      author: pr.mergeCommitAuthor,
      date: pr.mergeCommitDate
    }
  }

  private generateMetadataHash(commitInfo: CommitInfo): string {
    const input = commitInfo.author
      .concat(commitInfo.message)
      .concat(commitInfo.date.unix().toString())

    return crypto.createHash('sha256').update(input).digest('hex')
  }

  private async generateCommitPRs(
    octokit: Octokit
  ): Promise<PullRequestInfo[]> {
    const commits = await this.getCommitHistory(octokit)
    if (commits.length === 0) {
      return []
    }

    return commits.map(function (commit) {
      return {
        number: 0,
        title: commit.summary,
        htmlURL: '',
        mergedAt: commit.date,
        mergeCommitSha: '',
        mergeCommitAuthor: '',
        mergeCommitMessage: '',
        mergeCommitDate: commit.date,
        mergeCommitSummary: '',
        author: commit.author || '',
        repoName: '',
        labels: [],
        milestone: '',
        body: commit.message || '',
        assignees: [],
        requestedReviewers: []
      }
    })
  }
}
